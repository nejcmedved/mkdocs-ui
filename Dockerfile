# --- frontend build ---------------------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- python base: dependencies only (shared by dev and production) -------------------------
FROM python:3.12-slim AS backend-base
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MKDOCS_UI_CONFIG=/config/config.yaml

# Extra MkDocs plugins/themes your projects need, e.g.:
#   docker build --build-arg EXTRA_PIP="mkdocs-awesome-pages-plugin mkdocs-mermaid2-plugin" .
ARG EXTRA_PIP=""

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install -r requirements.txt ${EXTRA_PIP}
# UI/API on 8000; mkdocs previews from preview.base_port (8100) upwards, one per project
EXPOSE 8000 8100-8119

# --- dev: source is bind-mounted, auto-reload on change (docker-compose-dev.yaml) ---------
FROM backend-base AS backend-dev
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--reload-dir", "app"]

# --- production ---------------------------------------------------------------------------
FROM backend-base
COPY backend/app ./app
COPY --from=frontend /build/dist ./static
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
