from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import yaml
from pydantic import BaseModel

from .collab import CollabServer
from .config import (
    Project, Settings, build_settings, dump_config, find_mkdocs_file, load_settings,
    write_config_text,
)
from .preview import PreviewManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = load_settings()
collab = CollabServer(settings)
previews = PreviewManager(settings.projects, settings.preview_enabled)

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
HIDDEN = {".git", "__pycache__", ".DS_Store"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    previews.start_all()
    async with collab:
        yield
        collab.flush_all()
    previews.stop_all()


app = FastAPI(title="MkDocs UI", lifespan=lifespan)


def get_project(name: str) -> Project:
    project = settings.projects.get(name)
    if project is None:
        raise HTTPException(404, f"Unknown project: {name}")
    return project


def resolve(project: Project, rel_path: str) -> Path:
    try:
        return project.resolve(rel_path)
    except ValueError as e:
        raise HTTPException(400, str(e))


def rel(project: Project, path: Path) -> str:
    return path.relative_to(project.docs_dir).as_posix()


def build_tree(project: Project, directory: Path) -> list[dict]:
    entries = sorted(directory.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    tree = []
    for entry in entries:
        if entry.name in HIDDEN:
            continue
        node = {"name": entry.name, "path": rel(project, entry)}
        if entry.is_dir():
            node["type"] = "dir"
            node["children"] = build_tree(project, entry)
        else:
            node["type"] = "file"
        tree.append(node)
    return tree


# --- projects -----------------------------------------------------------------------------

@app.get("/api/projects")
def list_projects():
    return [
        {
            "name": p.name,
            "previewPort": p.preview_port if p.name in previews.processes else None,
            "previewHost": settings.preview_host,
            "useDirectoryUrls": p.use_directory_urls,
            "previewStatus": previews.processes[p.name].status if p.name in previews.processes else None,
        }
        for p in settings.projects.values()
    ]


@app.get("/api/projects/{name}/tree")
def project_tree(name: str):
    project = get_project(name)
    return build_tree(project, project.docs_dir)


@app.get("/api/projects/{name}/active")
def active_files(name: str):
    """Files currently open in the editor, with the number of connected users."""
    prefix = name + "/"
    return {k[len(prefix):]: v for k, v in collab.active_files().items() if k.startswith(prefix)}


@app.get("/api/projects/{name}/preview/logs")
def preview_logs(name: str):
    proc = previews.processes.get(name)
    if proc is None:
        raise HTTPException(404, "Preview not enabled for this project")
    return {"status": proc.status, "logs": list(proc.logs)}


@app.post("/api/projects/{name}/preview/restart")
def preview_restart(name: str):
    proc = previews.processes.get(name)
    if proc is None:
        raise HTTPException(404, "Preview not enabled for this project")
    proc.restart()
    return {"status": proc.status}


# --- app config -----------------------------------------------------------------------------

config_lock = asyncio.Lock()


def config_payload() -> dict:
    path = settings.config_path
    return {
        "raw": settings.raw,
        "yaml": path.read_text(encoding="utf-8") if path.is_file() else dump_config(settings.raw),
        "configPath": str(path),
        "allowedRoots": [str(r) for r in settings.allowed_roots],
        "errors": settings.errors,
    }


class ConfigUpdate(BaseModel):
    raw: dict | None = None   # structured edit from the settings form
    yaml: str | None = None   # raw YAML from the editor tab (keeps comments)


async def apply_settings(new: Settings) -> None:
    """Swap in a new config without restarting: disconnect editors of removed/changed projects, sync previews."""
    affected = [n for n, p in settings.projects.items() if new.projects.get(n) != p]
    for name in affected:
        await collab.close_rooms(collab.rooms_under(name, ""))
    vars(settings).update(vars(new))
    await asyncio.to_thread(previews.sync, settings.projects, settings.preview_enabled)


@app.get("/api/config")
def get_config():
    return config_payload()


@app.put("/api/config")
async def put_config(update: ConfigUpdate):
    if update.yaml is not None:
        try:
            raw = yaml.safe_load(update.yaml) or {}
        except yaml.YAMLError as e:
            raise HTTPException(400, f"YAML syntax error: {e}")
        text = update.yaml
    elif update.raw is not None:
        raw, text = update.raw, dump_config(update.raw)
    else:
        raise HTTPException(400, "Nothing to save")

    async with config_lock:
        try:
            new = build_settings(raw, settings.config_path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        try:
            write_config_text(settings.config_path, text)
        except OSError as e:
            raise HTTPException(500, f"Cannot write {settings.config_path}: {e}")
        await apply_settings(new)
    return config_payload()


@app.get("/api/fs")
def browse(path: str = ""):
    """List sub-folders for the project folder picker, limited to allowed_roots when set."""
    if not path:
        if settings.allowed_roots:
            dirs = [{"name": str(r), "path": str(r), "mkdocs": find_mkdocs_file(r) is not None}
                    for r in settings.allowed_roots if r.is_dir()]
            return {"path": "", "parent": None, "dirs": dirs}
        path = str(settings.config_path.parent)
    current = Path(path).resolve()
    if not settings.is_allowed(current):
        raise HTTPException(403, "Outside allowed_roots")
    if not current.is_dir():
        raise HTTPException(404, "Not a folder")
    dirs = []
    try:
        children = sorted(current.iterdir(), key=lambda p: p.name.lower())
    except PermissionError:
        children = []
    for child in children:
        try:
            if child.is_dir() and not child.name.startswith(".") and child.name not in HIDDEN:
                dirs.append({"name": child.name, "path": str(child), "mkdocs": find_mkdocs_file(child) is not None})
        except OSError:
            continue
    parent = current.parent
    if parent == current or not settings.is_allowed(parent):
        parent_path = "" if settings.allowed_roots else (None if parent == current else str(parent))
    else:
        parent_path = str(parent)
    return {"path": str(current), "parent": parent_path, "dirs": dirs, "mkdocs": find_mkdocs_file(current) is not None}


class InitRequest(BaseModel):
    path: str
    site_name: str


@app.post("/api/fs/init")
def init_mkdocs(req: InitRequest):
    """Create a minimal MkDocs project (mkdocs.yml + docs/index.md) in a new or existing folder."""
    root = Path(req.path).resolve()
    if not settings.is_allowed(root):
        raise HTTPException(403, "Outside allowed_roots")
    if not root.parent.is_dir():
        raise HTTPException(404, f"Parent folder does not exist: {root.parent}")
    if find_mkdocs_file(root):
        raise HTTPException(409, "This folder already contains a mkdocs.yml")
    root.mkdir(exist_ok=True)
    site_name = req.site_name.strip() or root.name
    (root / "mkdocs.yml").write_text(
        yaml.safe_dump({"site_name": site_name, "theme": {"name": "material"}}, sort_keys=False),
        encoding="utf-8",
    )
    (root / "docs").mkdir(exist_ok=True)
    index = root / "docs" / "index.md"
    if not index.exists():
        index.write_text(f"# {site_name}\n\nStart writing here.\n", encoding="utf-8")
    return {"path": str(root)}


# --- files --------------------------------------------------------------------------------

class CreateRequest(BaseModel):
    path: str
    type: str = "file"  # "file" | "dir"


class RenameRequest(BaseModel):
    path: str
    new_path: str


@app.post("/api/projects/{name}/files")
def create_entry(name: str, req: CreateRequest):
    project = get_project(name)
    target = resolve(project, req.path)
    if target.exists():
        raise HTTPException(409, "Already exists")
    if req.type == "dir":
        target.mkdir(parents=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        title = target.stem.replace("-", " ").replace("_", " ").title()
        target.write_text(f"# {title}\n\n" if target.suffix == ".md" else "", encoding="utf-8")
    return {"path": rel(project, target)}


@app.post("/api/projects/{name}/rename")
async def rename_entry(name: str, req: RenameRequest):
    project = get_project(name)
    src, dst = resolve(project, req.path), resolve(project, req.new_path)
    if not src.exists():
        raise HTTPException(404, "Not found")
    if dst.exists():
        raise HTTPException(409, "Target already exists")
    await collab.close_rooms(collab.rooms_under(name, req.path))
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return {"path": rel(project, dst)}


@app.delete("/api/projects/{name}/files")
async def delete_entry(name: str, path: str):
    project = get_project(name)
    target = resolve(project, path)
    if target == project.docs_dir:
        raise HTTPException(400, "Cannot delete the docs directory")
    if not target.exists():
        raise HTTPException(404, "Not found")
    await collab.close_rooms(collab.rooms_under(name, path), discard=True)
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"ok": True}


@app.get("/api/projects/{name}/raw/{path:path}")
def raw_file(name: str, path: str):
    project = get_project(name)
    target = resolve(project, path)
    if not target.is_file():
        raise HTTPException(404, "Not found")
    return FileResponse(target)


def _safe_filename(filename: str) -> str:
    stem, suffix = Path(filename).stem, Path(filename).suffix.lower()
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")[:60] or "image"
    return f"{stem}{suffix or '.png'}"


@app.post("/api/projects/{name}/upload")
async def upload_image(name: str, file: UploadFile = File(...), document: str = Form("")):
    """Store an image under the project's assets dir and return a link relative to `document`."""
    project = get_project(name)
    if file.content_type not in IMAGE_TYPES:
        raise HTTPException(415, f"Unsupported image type: {file.content_type}")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image too large")

    filename = f"{time.strftime('%Y%m%d-%H%M%S')}-{_safe_filename(file.filename or 'image.png')}"
    target = resolve(project, f"{project.assets_dir}/{filename}")
    counter = 1
    while target.exists():
        stem, suffix = Path(filename).stem, Path(filename).suffix
        target = resolve(project, f"{project.assets_dir}/{stem}-{counter}{suffix}")
        counter += 1
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)

    image_rel = PurePosixPath(rel(project, target))
    doc_dir = PurePosixPath(document).parent
    link = _relative_posix(image_rel, doc_dir)
    return {"path": str(image_rel), "link": link}


def _relative_posix(target: PurePosixPath, start: PurePosixPath) -> str:
    t, s = target.parts, [p for p in start.parts if p != "."]
    common = 0
    while common < min(len(t), len(s)) and t[common] == s[common]:
        common += 1
    return "/".join([".."] * (len(s) - common) + list(t[common:]))


# --- collaboration websocket --------------------------------------------------------------

@app.websocket("/ws/{name}/{path:path}")
async def collab_ws(websocket: WebSocket, name: str, path: str):
    project = settings.projects.get(name)
    if project is None:
        await websocket.close(code=4004)
        return
    try:
        target = project.resolve(path)
    except ValueError:
        await websocket.close(code=4000)
        return
    await websocket.accept()
    await collab.serve_websocket(websocket, f"{name}/{rel(project, target)}")


# --- frontend -----------------------------------------------------------------------------

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and STATIC_DIR in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
