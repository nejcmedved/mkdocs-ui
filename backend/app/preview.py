"""Runs one `mkdocs serve` process per project and keeps it alive."""

from __future__ import annotations

import collections
import logging
import os
import subprocess
import sys
import threading
import time

from .config import Project

log = logging.getLogger(__name__)

RESTART_DELAY = 3.0


class PreviewProcess:
    def __init__(self, project: Project):
        self.project = project
        self.proc: subprocess.Popen | None = None
        self.logs: collections.deque[str] = collections.deque(maxlen=500)
        self._stopping = False
        self._lock = threading.Lock()

    @property
    def status(self) -> str:
        if self.proc is None:
            return "stopped"
        return "running" if self.proc.poll() is None else "crashed"

    def start(self) -> None:
        with self._lock:
            if self.proc and self.proc.poll() is None:
                return
            self._stopping = False
            cmd = [
                sys.executable, "-m", "mkdocs", "serve",
                "--dev-addr", f"0.0.0.0:{self.project.preview_port}",
                "--config-file", str(self.project.mkdocs_file),
            ]
            self.logs.append(f"$ {' '.join(cmd)}")
            self.proc = subprocess.Popen(
                cmd,
                cwd=self.project.root,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()

    def _pump(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            self.logs.append(line.rstrip())
        code = proc.wait()
        self.logs.append(f"[mkdocs exited with code {code}]")
        # Only the pump of the current process may restart it (not one replaced by restart()).
        if not self._stopping and proc is self.proc:
            log.warning("Preview for %s exited (%s), restarting", self.project.name, code)
            time.sleep(RESTART_DELAY)
            if not self._stopping:
                self.start()

    def stop(self) -> None:
        with self._lock:
            self._stopping = True
            if self.proc and self.proc.poll() is None:
                if os.name == "nt":
                    # venv python.exe is a launcher that spawns the real interpreter: kill the tree
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], capture_output=True)
                else:
                    self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()

    def restart(self) -> None:
        self.stop()
        self.start()


class PreviewManager:
    def __init__(self, projects: dict[str, Project], enabled: bool):
        self.enabled = enabled
        self.processes = {
            name: PreviewProcess(p) for name, p in projects.items() if p.preview_port
        } if enabled else {}

    def start_all(self) -> None:
        for p in self.processes.values():
            p.start()

    def stop_all(self) -> None:
        for p in self.processes.values():
            p.stop()

    def sync(self, projects: dict[str, Project], enabled: bool) -> None:
        """Bring running previews in line with a new config: stop removed/changed, start new ones."""
        self.enabled = enabled
        wanted = {n: p for n, p in projects.items() if p.preview_port} if enabled else {}
        for name, proc in list(self.processes.items()):
            if wanted.get(name) != proc.project:
                proc.stop()
                del self.processes[name]
        for name, project in wanted.items():
            if name not in self.processes:
                self.processes[name] = PreviewProcess(project)
                self.processes[name].start()
