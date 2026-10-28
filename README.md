# MkDocs UI

A browser-based, real-time collaborative editor for one or more existing MkDocs projects.

- **Multiple projects** from a single config file
- **Real-time collaboration** (Yjs CRDT): live cursors, presence, conflict-free concurrent edits
- **Autosave** to the project folder on disk (debounced, plus a flush when the last editor leaves)
- **Live preview** via a real `mkdocs serve` per project, so theme and plugins render exactly
- **Images**: paste, drag & drop, or pick a file; stored under `docs/assets/images/` and linked relatively
- File tree with create / rename / move / delete
- **Settings in the UI** (⚙): add/remove projects with a server-side folder browser, create new MkDocs
  projects, edit preview/autosave options or the raw YAML. Changes apply live, without a restart

## Run with Docker

```bash
docker compose up -d --build
```

Open http://localhost:8000. Mount the folder holding your MkDocs projects at `/docs` (see `docker-compose.yml`),
then add projects from ⚙ Settings, or edit `docker/config.yaml`. Ports `8100-8119` are published for previews.

### Making host folders visible

The container only sees folders that are mounted into it. Set `DOCS_ROOT` in `.env` (see `.env.example`) to the
host folder holding your docs projects; it appears as `/docs` in the folder browser. To add more folders, mount each
one *under* `/docs` so the default `allowed_roots: [/docs]` already covers them. A `docker-compose.override.yml`
next to `docker-compose.yml` is picked up automatically:

```yaml
services:
  mkdocs-ui:
    volumes:
      - D:/team-wiki:/docs/team-wiki
      - C:/Users/me/projects/product-docs:/docs/product-docs
```

If a mounted folder disappears, the projects using it are skipped at startup and listed as warnings in ⚙ Settings.

If your projects use plugins beyond `mkdocs-material`, install them at build time:

```bash
docker compose build --build-arg EXTRA_PIP="mkdocs-awesome-pages-plugin mkdocs-mermaid2-plugin"
```

Set `user: "<uid>:<gid>"` in `docker-compose.yml` so files are written with your host user's ownership.

## Configuration

Everything below can be edited from ⚙ Settings in the UI. The Projects tab rewrites the file (comments are lost),
and the YAML tab saves your text as-is. Invalid configs (missing folder, no `mkdocs.yml`, duplicate names or ports)
are rejected before anything is written.

```yaml
allowed_roots:                    # optional: folders the UI may browse / use as projects
  - /docs

projects:
  - name: handbook                # shown in the project picker, used in URLs
    path: /docs/handbook          # folder containing mkdocs.yml (relative to this config file, or absolute)
    assets_dir: assets/images     # optional: where uploaded images go, relative to docs_dir
    preview_port: 8100            # optional: defaults to the first free port from preview.base_port

preview:
  enabled: true
  base_port: 8100
  host: docs.example.local        # optional: hostname browsers use for preview links (default: UI hostname)

autosave_delay: 1.0               # seconds of inactivity before writing to disk
```

The config path is taken from `MKDOCS_UI_CONFIG` (default `./config.yaml`).

## Development

### With Docker (no local Python/Node needed)

```bash
docker compose -f docker-compose-dev.yaml up --build
```

Open http://localhost:5173. The backend restarts on changes in `backend/app/`, the frontend hot-reloads, and
previews stay on ports 8100+. File watching uses polling so it works on Windows/macOS bind mounts.
It uses the same ports as the production stack, so stop one before starting the other.

### Locally

```bash
# backend (http://localhost:8000)
cd backend
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # .venv/bin/pip on Linux/macOS
MKDOCS_UI_CONFIG=../config.yaml .venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# frontend (http://localhost:5173, proxies /api and /ws to :8000)
cd frontend
npm install
npm run dev
```

The root `config.yaml` points at the two sample projects in `examples/`.

## Notes and limitations

- Run a **single** backend worker: collaboration rooms live in memory.
- There is no authentication. Users just pick a display name, and anyone with access can change the config. Run it on a
  trusted network or behind an authenticating reverse proxy, and set `allowed_roots` to limit which folders can be used.
- If a file is changed on disk by something else (e.g. `git pull`) *while someone has it open*, the editor's
  version wins on the next save. Files that are not open are always read fresh from disk.
