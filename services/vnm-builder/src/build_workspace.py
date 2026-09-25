"""Private, writable build workspace staging.

The builder's supplied ``game_path`` is read-only source material. Before a
build starts, its tree is copied into an application-owned workspace under the
builder work root, and Ren'Py / compression only ever write inside that
workspace.

Symlink policy: the source root is resolved canonically, then every symlink is
resolved canonically and must stay inside that root. Contained symlinks are
materialized as independent regular files/directories; escaping, broken, or
cyclic symlinks fail workspace preparation. The workspace therefore contains no
symlinks, so a later write cannot follow a link back into the source tree, and
no file outside the source root is ever read.

Special filesystem entries (FIFOs, sockets, devices) are rejected rather than
copied/opened.
"""

import os
import shutil
from pathlib import Path

DEFAULT_WORK_ROOT = "/tmp/vnm-build-work"


def resolve_work_root(env: dict | None = None) -> Path:
    """Return the builder work root, honouring ``BUILD_WORK_PATH``."""
    env = env if env is not None else os.environ
    return Path(env.get("BUILD_WORK_PATH") or DEFAULT_WORK_ROOT)


def workspace_paths(work_root, job_id: str) -> tuple[Path, Path]:
    """Return ``(workspace, overlay)`` paths for a job, both under the work root."""
    root = Path(work_root)
    return root / f"build-{job_id}", root / f"build-{job_id}-overlay"


def stage_input_tree(source, workspace) -> Path:
    """Copy *source* into a fresh *workspace*, materializing contained symlinks.

    Policy:
      - the source root is resolved canonically;
      - a symlink target must resolve inside the canonical source root, or
        preparation fails (broken targets also fail);
      - contained symlinks become independent files/directories (no symlinks
        are left in the workspace);
      - directory symlink cycles are detected and fail preparation;
      - FIFOs/sockets/devices and any other non-regular entry fail preparation.

    The source tree is only ever read. Any pre-existing workspace is removed
    first, and a partial workspace from a failed attempt is removed again, so
    only this job's workspace is ever cleaned.
    """
    source = Path(source)
    workspace = Path(workspace)

    if not source.is_dir():
        raise FileNotFoundError(f"Build source is not a directory: {source}")

    source_root = os.path.realpath(source)
    prefix = source_root + os.sep

    def _contained_or_fail(link_path: Path, target_real: str) -> None:
        if not os.path.exists(target_real):
            raise RuntimeError(
                f"Broken symlink in build source: {link_path} -> "
                f"{os.readlink(link_path)}"
            )
        if target_real != source_root and not target_real.startswith(prefix):
            raise RuntimeError(
                f"Symlink escapes build source root: {link_path} -> {target_real}"
            )

    def _materialize_dir(real_dir: str, dest_dir: Path, active: frozenset) -> None:
        canonical = os.path.realpath(real_dir)
        if canonical in active:
            raise RuntimeError(
                f"Symlink directory cycle detected at {real_dir} ({canonical})"
            )
        branch = active | {canonical}
        dest_dir.mkdir(parents=True, exist_ok=True)

        with os.scandir(real_dir) as it:
            entries = list(it)

        for entry in entries:
            entry_path = Path(entry.path)
            dest = dest_dir / entry.name

            if entry.is_symlink():
                target_real = os.path.realpath(entry_path)
                _contained_or_fail(entry_path, target_real)
                if os.path.isdir(target_real):
                    _materialize_dir(target_real, dest, branch)
                elif os.path.isfile(target_real):
                    shutil.copy2(target_real, dest)
                else:
                    raise RuntimeError(
                        f"Unsupported special entry via symlink: {entry_path}"
                    )
            elif entry.is_dir(follow_symlinks=False):
                _materialize_dir(entry_path, dest, branch)
            elif entry.is_file(follow_symlinks=False):
                shutil.copy2(entry_path, dest)
            else:
                raise RuntimeError(f"Unsupported special entry: {entry_path}")

    try:
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.mkdir(parents=True, exist_ok=True)
        _materialize_dir(source_root, workspace, frozenset())
    except Exception:
        shutil.rmtree(workspace, ignore_errors=True)
        raise

    return workspace


def cleanup_workspace(workspace) -> None:
    """Remove a single workspace directory. Safe if it does not exist."""
    workspace = Path(workspace)
    if workspace.exists():
        shutil.rmtree(workspace, ignore_errors=True)
