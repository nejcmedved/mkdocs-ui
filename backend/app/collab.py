"""Real-time collaboration: one Yjs room per open file, persisted back to disk.

Each room holds a Y.Doc with a Text named "content" (the file body) and a Map named
"meta" where the server publishes the last save time. The file is loaded from disk when
the first client opens it and written back (debounced) on every change, plus a final
flush when the last client leaves.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from pycrdt import Doc, Map, Text
from pycrdt.websocket import WebsocketServer, YRoom
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from .config import Settings

log = logging.getLogger(__name__)


class StarletteChannel:
    """Adapts a Starlette WebSocket to the pycrdt Channel protocol."""

    def __init__(self, websocket: WebSocket, path: str):
        self._ws = websocket
        self._path = path

    @property
    def path(self) -> str:
        return self._path

    def __aiter__(self):
        return self

    async def __anext__(self) -> bytes:
        return await self.recv()

    async def send(self, message: bytes) -> None:
        if self._ws.client_state == WebSocketState.CONNECTED:
            try:
                await self._ws.send_bytes(message)
            except (WebSocketDisconnect, RuntimeError):
                pass

    async def recv(self) -> bytes:
        try:
            return await self._ws.receive_bytes()
        except (WebSocketDisconnect, RuntimeError, KeyError):
            raise StopAsyncIteration()

    async def close(self) -> None:
        if self._ws.client_state == WebSocketState.CONNECTED:
            try:
                await self._ws.close(code=4000, reason="file closed by server")
            except RuntimeError:
                pass


class FileRoom(YRoom):
    def __init__(self, file_path: Path, autosave_delay: float, **kwargs):
        self.file_path = file_path
        self.autosave_delay = autosave_delay
        self.crlf = False
        self.discard = False  # set when the file is deleted, so nothing gets written back
        self._save_handle: asyncio.TimerHandle | None = None
        self._dirty = False

        doc = Doc()
        self.text = doc.get("content", type=Text)
        self.meta = doc.get("meta", type=Map)
        if file_path.exists():
            raw = file_path.read_text(encoding="utf-8")
            self.crlf = "\r\n" in raw
            self.text += raw.replace("\r\n", "\n")
        self.meta["savedAt"] = time.time()
        super().__init__(ydoc=doc, **kwargs)
        self.text.observe(self._on_change)

    def _on_change(self, _event) -> None:
        self._dirty = True
        if self._save_handle:
            self._save_handle.cancel()
        loop = asyncio.get_running_loop()
        self._save_handle = loop.call_later(self.autosave_delay, self.save)

    def save(self) -> None:
        if self._save_handle:
            self._save_handle.cancel()
            self._save_handle = None
        if not self._dirty or self.discard:
            return
        content = str(self.text)
        if self.crlf:
            content = content.replace("\n", "\r\n")
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        with self.file_path.open("w", encoding="utf-8", newline="") as f:
            f.write(content)
        self._dirty = False
        self.meta["savedAt"] = time.time()
        log.info("Saved %s", self.file_path)


class CollabServer(WebsocketServer):
    """WebsocketServer whose rooms are named "<project>/<path inside docs_dir>"."""

    def __init__(self, settings: Settings):
        super().__init__(auto_clean_rooms=True, exception_handler=self._log_exception)
        self.settings = settings
        self.channels: dict[str, set[StarletteChannel]] = {}
        # Serializes room creation/start: two clients opening the same file at once would
        # otherwise both try to start the room and the second one would be dropped.
        self._rooms_lock = asyncio.Lock()

    @staticmethod
    def _log_exception(exception: Exception, logger: logging.Logger) -> bool:
        logger.error("Collaboration error", exc_info=exception)
        return True

    def _file_for(self, name: str) -> Path:
        project_name, _, rel = name.partition("/")
        project = self.settings.projects[project_name]
        return project.resolve(rel)

    async def get_room(self, name: str) -> YRoom:
        async with self._rooms_lock:
            if name not in self.rooms:
                self.rooms[name] = FileRoom(
                    self._file_for(name),
                    self.settings.autosave_delay,
                    exception_handler=self.exception_handler,
                    log=self.log,
                )
            room = self.rooms[name]
            await self.start_room(room)
        return room

    async def start_room(self, room: YRoom) -> None:
        # WebsocketServer.serve() calls this again right after get_room(); only start once.
        if not room.started.is_set():
            await super().start_room(room)

    async def delete_room(self, *, name: str | None = None, room: YRoom | None = None) -> None:
        if name is None:
            name = self.get_room_name(room)
        target = self.rooms.get(name)
        if isinstance(target, FileRoom):
            target.save()
        await super().delete_room(name=name)

    async def serve_websocket(self, websocket: WebSocket, name: str) -> None:
        channel = StarletteChannel(websocket, name)
        self.channels.setdefault(name, set()).add(channel)
        try:
            await self.serve(channel)
        finally:
            self.channels[name].discard(channel)
            if not self.channels[name]:
                del self.channels[name]

    def rooms_under(self, project: str, rel_path: str) -> list[str]:
        prefix = f"{project}/{rel_path.strip('/')}".rstrip("/")
        return [n for n in self.rooms if n == prefix or n.startswith(prefix + "/")]

    async def close_rooms(self, names: list[str], discard: bool = False) -> None:
        """Flush (or discard) open rooms and disconnect their clients, e.g. before a rename/delete."""
        for name in names:
            room = self.rooms.get(name)
            if isinstance(room, FileRoom):
                room.discard = discard
                room.save()
            for channel in list(self.channels.get(name, ())):
                await channel.close()

    def flush_all(self) -> None:
        for room in self.rooms.values():
            if isinstance(room, FileRoom):
                room.save()

    def active_files(self) -> dict[str, int]:
        """Map of room name -> number of connected clients."""
        return {name: len(room.clients) for name, room in self.rooms.items()}
