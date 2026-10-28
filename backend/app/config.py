"""Application config, loaded from a YAML file (MKDOCS_UI_CONFIG, default ./config.yaml)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml


class _LenientLoader(yaml.SafeLoader):
    """SafeLoader that tolerates the custom tags mkdocs.yml files often use (!!python/name, !ENV, ...)."""


def _ignore_tag(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)


_LenientLoader.add_multi_constructor("", _ignore_tag)


def load_yaml_lenient(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return yaml.load(f, Loader=_LenientLoader) or {}


@dataclass
class Project:
    name: str
    root: Path
    mkdocs_file: Path
    docs_dir: Path
    assets_dir: str
    use_directory_urls: bool
    preview_port: int | None

    def resolve(self, rel_path: str) -> Path:
        """Resolve a path relative to docs_dir, refusing anything that escapes it."""
        rel_path = rel_path.replace("\\", "/").strip("/")
        target = (self.docs_dir / rel_path).resolve()
        if target != self.docs_dir and self.docs_dir not in target.parents:
            raise ValueError(f"Path escapes docs dir: {rel_path}")
        return target


@dataclass
class Settings:
    projects: dict[str, Project] = field(default_factory=dict)
    preview_enabled: bool = True
    preview_host: str | None = None
    autosave_delay: float = 1.0
    # Folders the UI may browse and use as projects; empty means unrestricted.
    allowed_roots: list[Path] = field(default_factory=list)
    config_path: Path = Path("config.yaml")
    raw: dict = field(default_factory=dict)
    # Problems found when loading leniently (startup): those projects are skipped, not fatal.
    errors: list[str] = field(default_factory=list)

    def is_allowed(self, path: Path) -> bool:
        path = path.resolve()
        return not self.allowed_roots or any(r == path or r in path.parents for r in self.allowed_roots)


NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


def find_mkdocs_file(root: Path) -> Path | None:
    for name in ("mkdocs.yml", "mkdocs.yaml"):
        if (root / name).is_file():
            return root / name
    return None


def config_file_path() -> Path:
    return Path(os.environ.get("MKDOCS_UI_CONFIG", "config.yaml")).resolve()


def build_settings(raw: dict, config_path: Path, strict: bool = True) -> Settings:
    """Validate a raw config dict and turn it into Settings. Raises ValueError with a readable message.

    With strict=False an invalid project is skipped and reported in settings.errors instead, so one
    missing folder (e.g. after changing a Docker mount) doesn't stop the whole app from starting.
    """
    if not isinstance(raw, dict):
        raise ValueError("Config must be a YAML mapping")
    base = config_path.parent
    preview = raw.get("preview") or {}
    try:
        settings = Settings(
            preview_enabled=bool(preview.get("enabled", True)),
            preview_host=preview.get("host") or None,
            autosave_delay=float(raw.get("autosave_delay", 1.0)),
            allowed_roots=[(base / r).resolve() for r in raw.get("allowed_roots") or []],
            config_path=config_path,
            raw=raw,
        )
        base_port = int(preview.get("base_port", 8100))
    except (TypeError, ValueError) as e:
        raise ValueError(f"Invalid value: {e}")

    entries = raw.get("projects") or []
    if not isinstance(entries, list):
        raise ValueError("'projects' must be a list")

    # Explicit ports first, then hand out free ports from base_port for the rest.
    used_ports: set[int] = set()
    for entry in entries:
        port = entry.get("preview_port") if isinstance(entry, dict) else None
        if port not in (None, ""):
            if int(port) in used_ports:
                raise ValueError(f"Preview port {port} is used by more than one project")
            used_ports.add(int(port))
    next_port = base_port

    def add_project(entry) -> None:
        nonlocal next_port
        if not isinstance(entry, dict) or not entry.get("name") or not entry.get("path"):
            raise ValueError("Every project needs a 'name' and a 'path'")
        name = str(entry["name"])
        if not NAME_RE.match(name):
            raise ValueError(f"Invalid project name {name!r}: use letters, digits, '-', '_' or '.'")
        if name in settings.projects:
            raise ValueError(f"Duplicate project name: {name!r}")
        root = (base / str(entry["path"])).resolve()
        if not root.is_dir():
            raise ValueError(f"Project {name!r}: folder does not exist: {root}")
        if not settings.is_allowed(root):
            raise ValueError(f"Project {name!r}: {root} is outside allowed_roots")
        mkdocs_file = find_mkdocs_file(root)
        if mkdocs_file is None:
            raise ValueError(f"Project {name!r}: no mkdocs.yml in {root}")
        try:
            mkdocs_cfg = load_yaml_lenient(mkdocs_file)
        except yaml.YAMLError as e:
            raise ValueError(f"Project {name!r}: cannot parse {mkdocs_file.name}: {e}")
        docs_dir = (root / mkdocs_cfg.get("docs_dir", "docs")).resolve()
        docs_dir.mkdir(parents=True, exist_ok=True)

        port = entry.get("preview_port")
        if port in (None, ""):
            while next_port in used_ports:
                next_port += 1
            port = next_port
            used_ports.add(port)
        settings.projects[name] = Project(
            name=name,
            root=root,
            mkdocs_file=mkdocs_file,
            docs_dir=docs_dir,
            assets_dir=str(entry.get("assets_dir") or "assets/images").strip("/"),
            use_directory_urls=mkdocs_cfg.get("use_directory_urls", True),
            preview_port=int(port),
        )

    for entry in entries:
        try:
            add_project(entry)
        except ValueError as e:
            if strict:
                raise
            settings.errors.append(str(e))
    return settings


def load_settings(config_path: Path | None = None) -> Settings:
    """Load the config at startup. Never fails: problems are reported in settings.errors."""
    config_path = config_path or config_file_path()
    try:
        raw = load_yaml_lenient(config_path) if config_path.exists() else {}
        return build_settings(raw, config_path, strict=False)
    except (ValueError, yaml.YAMLError) as e:
        return Settings(config_path=config_path, errors=[f"Config not loaded: {e}"])


def write_config_text(config_path: Path, text: str) -> None:
    """Write the config atomically where possible (a single-file bind mount can't be replaced)."""
    tmp = config_path.with_name(config_path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, config_path)
    except OSError:
        tmp.unlink(missing_ok=True)
        config_path.write_text(text, encoding="utf-8")


def dump_config(raw: dict) -> str:
    return yaml.safe_dump(raw, sort_keys=False, allow_unicode=True)
