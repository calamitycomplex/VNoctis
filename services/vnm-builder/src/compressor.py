"""Image compression for web builds — operates on an independent copy overlay.

Creates an overlay directory containing independent copies of every file from
the source tree (no symlinks, no hard links) and places compressed copies of
images. The Ren'Py ``web_build`` command is then pointed at the overlay so
compressed images are baked into the web build while the source files remain
untouched.

Because the overlay is fully independent, a later write in the overlay can
never modify a file in the builder workspace or the original input tree.

Compression tools:
  - jpegoptim  — lossy JPEG re-quantisation + metadata strip
  - pngquant   — lossy palette quantisation (preserves transparency)
  - Pillow     — WebP re-encoding and BMP→PNG conversion

Image-output collision safety:
  - every image is written to a unique temporary file and then atomically moved
    into place with ``os.replace``;
  - a BMP's derived ``foo.png`` output is only produced when no other job owns
    that path (an existing ``foo.png`` source file owns it instead);
  - no worker can overwrite another worker's committed output.

Environment variables (all optional):
  COMPRESS_JPEG_QUALITY  0-100 (default: 80)
  COMPRESS_PNG_QUALITY  "min-max" (default: "60-80")
  COMPRESS_WEBP_QUALITY  0-100 (default: 80)
  COMPRESS_WORKERS       int, 0 = auto (default: 0)
"""

import asyncio
import os
import shutil
import time
from concurrent.futures import ProcessPoolExecutor
from functools import partial
from pathlib import Path
from uuid import uuid4

from logger import setup_logger

logger = setup_logger("vnm-builder.compressor")

# Extensions we attempt to compress.  Everything else is copied.
IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})

# Name of the temp dir (inside the overlay) used for collision-safe placement.
TEMP_DIRNAME = ".vnm-tmp"

# ── Defaults (overridable via env) ───────────────────────────

DEFAULT_JPEG_QUALITY = 80
DEFAULT_PNG_QUALITY = "60-80"
DEFAULT_WEBP_QUALITY = 80


def _env_bool(name: str, default: bool = True) -> bool:
    val = os.environ.get(name, "").strip().lower()
    if val in ("0", "false", "no", "off"):
        return False
    if val in ("1", "true", "yes", "on"):
        return True
    return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except (ValueError, AttributeError):
        return default


def _env_str(name: str, default: str) -> str:
    val = os.environ.get(name, "").strip()
    return val if val else default


# ── Collision-safe placement ─────────────────────────────────

def _unique_tmp(tmp_dir: Path, suffix: str = ".tmp") -> Path:
    """Return a unique temporary path inside *tmp_dir*."""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    return tmp_dir / f"{uuid4().hex}{suffix}"


def _place(tmp: Path, dst: Path) -> None:
    """Atomically move *tmp* into *dst*, creating parent dirs as needed."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.replace(tmp, dst)


# ── Per-image compression (runs in ProcessPoolExecutor) ──────

def _compress_one(
    src: str,
    dst: str,
    ext: str,
    secondary: str | None,
    jpeg_quality: int,
    png_quality: str,
    webp_quality: int,
    tmp_dir: str,
) -> tuple[str, int, int, str | None]:
    """Compress a single image file into independent outputs.

    Returns ``(relative_path, original_bytes, compressed_bytes, error_or_None)``.
    Runs in a worker process — must not reference any asyncio objects.

    All outputs are written to unique temp files first and atomically placed, so
    concurrent jobs cannot overwrite each other or unrelated workspace content.
    """
    src_p = Path(src)
    dst_p = Path(dst)
    tmp_dir_p = Path(tmp_dir)
    original_size = src_p.stat().st_size

    try:
        if ext in (".jpg", ".jpeg"):
            tmp = _unique_tmp(tmp_dir_p)
            _compress_jpeg(src_p, tmp, jpeg_quality)
            _place(tmp, dst_p)

        elif ext == ".png":
            tmp = _unique_tmp(tmp_dir_p)
            _compress_png(src_p, tmp, png_quality)
            _place(tmp, dst_p)

        elif ext == ".webp":
            tmp = _unique_tmp(tmp_dir_p)
            _compress_webp(src_p, tmp, webp_quality)
            _place(tmp, dst_p)

        elif ext == ".bmp":
            # Derived PNG output (only when this job owns that path) + a copy of
            # the original .bmp name so Ren'Py can still find it.
            tmp_png = _unique_tmp(tmp_dir_p, ".png")
            _compress_bmp(src_p, tmp_png)
            if secondary:
                _place(tmp_png, Path(secondary))
            else:
                tmp_png.unlink(missing_ok=True)

            tmp_bmp = _unique_tmp(tmp_dir_p)
            shutil.copy2(src_p, tmp_bmp)
            _place(tmp_bmp, dst_p)

        else:
            # Should not happen — independent copy.
            tmp = _unique_tmp(tmp_dir_p)
            shutil.copy2(src_p, tmp)
            _place(tmp, dst_p)

        return (src, original_size, dst_p.stat().st_size, None)

    except Exception as exc:
        # On failure, place an independent copy — never a symlink.
        try:
            tmp = _unique_tmp(tmp_dir_p)
            shutil.copy2(src_p, tmp)
            _place(tmp, dst_p)
        except Exception:
            pass
        return (src, original_size, original_size, str(exc))


def _compress_jpeg(src: Path, dst: Path, quality: int) -> int:
    """Lossy JPEG re-compression via jpegoptim."""
    import subprocess

    # jpegoptim works in-place, so copy first
    shutil.copy2(src, dst)
    subprocess.run(
        [
            "jpegoptim",
            f"--max={quality}",
            "--strip-all",
            "--quiet",
            str(dst),
        ],
        check=False,
        capture_output=True,
    )
    return dst.stat().st_size


def _compress_png(src: Path, dst: Path, quality: str) -> int:
    """Lossy PNG quantisation via pngquant (fallback: independent copy)."""
    import subprocess

    subprocess.run(
        [
            "pngquant",
            "--quality",
            quality,
            "--force",
            "--skip-if-larger",
            "--output",
            str(dst),
            str(src),
        ],
        check=False,
        capture_output=True,
    )
    if not dst.exists():
        # pngquant skipped (--skip-if-larger) or failed — keep an independent copy.
        shutil.copy2(src, dst)
    return dst.stat().st_size


def _compress_webp(src: Path, dst: Path, quality: int) -> int:
    """Re-encode WebP at target quality via Pillow (fallback: independent copy)."""
    from PIL import Image

    img = Image.open(src)
    img.save(dst, "WEBP", quality=quality, method=4)
    # If Pillow made it bigger, keep the original bytes instead.
    if dst.stat().st_size >= src.stat().st_size:
        shutil.copy2(src, dst)
    return dst.stat().st_size


def _compress_bmp(src: Path, dst_png: Path) -> int:
    """Convert BMP → PNG (BMP is uncompressed; this always wins)."""
    from PIL import Image

    img = Image.open(src)
    img.save(dst_png, "PNG", optimize=True)
    return dst_png.stat().st_size


# ── Job planning ─────────────────────────────────────────────

def _plan_image_jobs(game: Path, overlay: Path):
    """Plan image jobs and non-image copies.

    Returns ``(image_jobs, copy_files)`` where each image job is
    ``(src, dst, ext, secondary_or_None)``. A BMP's derived ``<stem>.png`` is
    only claimed when no other image job already owns that path, so no two jobs
    ever write the same destination.
    """
    image_jobs: list[tuple[Path, Path, str]] = []
    copy_files: list[tuple[Path, Path]] = []

    for root, dirs, files in os.walk(game):
        rel_root = Path(root).relative_to(game)
        target_dir = overlay / rel_root
        target_dir.mkdir(parents=True, exist_ok=True)

        for filename in files:
            src_file = Path(root) / filename
            dst_file = target_dir / filename
            ext = src_file.suffix.lower()

            if ext in IMAGE_EXTENSIONS:
                image_jobs.append((src_file, dst_file, ext))
            else:
                copy_files.append((src_file, dst_file))

    primary_owners = {dst for _, dst, _ in image_jobs}
    claimed_secondary: set[Path] = set()

    planned: list[tuple[Path, Path, str, Path | None]] = []
    for src_file, dst_file, ext in image_jobs:
        secondary: Path | None = None
        if ext == ".bmp":
            candidate = dst_file.with_suffix(".png")
            if candidate not in primary_owners and candidate not in claimed_secondary:
                secondary = candidate
                claimed_secondary.add(candidate)
        planned.append((src_file, dst_file, ext, secondary))

    return planned, copy_files


# ── Public API ───────────────────────────────────────────────


async def create_compressed_overlay(
    game_path: str,
    overlay_path: str,
    log_callback=None,
) -> dict:
    """Create an independent-copy overlay of *game_path* with compressed images.

    Every file in the overlay is an independent copy (no symlinks, no hard
    links), so later writes in the overlay cannot affect the source tree.

    Parameters
    ----------
    game_path : str
        Path to the game directory to read (e.g. the private build workspace).
    overlay_path : str
        Path for the temporary overlay.
    log_callback : async callable(str), optional
        Called with progress messages.

    Returns
    -------
    dict
        Statistics: images, copies, original_bytes, compressed_bytes,
        errors, elapsed_s.
    """
    game = Path(game_path)
    overlay = Path(overlay_path)
    tmp_dir = overlay / TEMP_DIRNAME

    # Read config from environment
    jpeg_quality = _env_int("COMPRESS_JPEG_QUALITY", DEFAULT_JPEG_QUALITY)
    png_quality = _env_str("COMPRESS_PNG_QUALITY", DEFAULT_PNG_QUALITY)
    webp_quality = _env_int("COMPRESS_WEBP_QUALITY", DEFAULT_WEBP_QUALITY)
    workers = _env_int("COMPRESS_WORKERS", 0) or os.cpu_count() or 4

    async def _log(msg: str):
        if log_callback:
            await log_callback(msg)

    # ── Clean slate ──────────────────────────────────────
    if overlay.exists():
        await asyncio.to_thread(shutil.rmtree, overlay)
    overlay.mkdir(parents=True, exist_ok=True)

    await _log(
        f"[compressor] Scanning {game} for compressible images "
        f"(jpeg_q={jpeg_quality}, png_q={png_quality}, webp_q={webp_quality}, "
        f"workers={workers})"
    )

    image_jobs, copy_files = _plan_image_jobs(game, overlay)
    copy_count = len(copy_files)

    # ── Independent copies of all non-image files ────────
    for src_file, dst_file in copy_files:
        dst_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dst_file)

    await _log(
        f"[compressor] Found {len(image_jobs)} images to compress, "
        f"{copy_count} files copied"
    )

    if not image_jobs:
        return {
            "images": 0,
            "copies": copy_count,
            "original_bytes": 0,
            "compressed_bytes": 0,
            "errors": 0,
            "elapsed_s": time.monotonic() - time.monotonic(),
        }

    t0 = time.monotonic()

    # ── Parallel compression ─────────────────────────────
    loop = asyncio.get_running_loop()
    compress_fn = partial(
        _compress_one,
        tmp_dir=str(tmp_dir),
        jpeg_quality=jpeg_quality,
        png_quality=png_quality,
        webp_quality=webp_quality,
    )

    total_original = 0
    total_compressed = 0
    error_count = 0
    done_count = 0
    total = len(image_jobs)

    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = []
        for src, dst, ext, secondary in image_jobs:
            future = loop.run_in_executor(
                pool, compress_fn, str(src), str(dst), ext, str(secondary) if secondary else None
            )
            futures.append(future)

        for coro in asyncio.as_completed(futures):
            src, orig_sz, comp_sz, err = await coro
            total_original += orig_sz
            total_compressed += comp_sz
            done_count += 1
            if err:
                error_count += 1
                logger.warning("Compression failed for %s: %s", src, err)

            if done_count % 200 == 0 or done_count == total:
                pct = done_count / total * 100
                saved_mb = (total_original - total_compressed) / (1024 * 1024)
                ratio = (
                    total_compressed / total_original * 100
                    if total_original > 0
                    else 0
                )
                await _log(
                    f"[compressor] {done_count}/{total} ({pct:.0f}%) — "
                    f"saved {saved_mb:.0f} MB so far ({ratio:.0f}% of original)"
                )

    elapsed = time.monotonic() - t0
    savings_mb = (total_original - total_compressed) / (1024 * 1024)
    ratio = (
        total_compressed / total_original * 100
        if total_original > 0
        else 0
    )

    await _log(
        f"[compressor] ✅ Done in {elapsed:.1f}s — "
        f"{done_count} images, {savings_mb:.0f} MB saved "
        f"({ratio:.0f}% of original), {error_count} errors"
    )

    return {
        "images": done_count,
        "copies": copy_count,
        "original_bytes": total_original,
        "compressed_bytes": total_compressed,
        "errors": error_count,
        "elapsed_s": elapsed,
    }


def cleanup_overlay(overlay_path: str):
    """Remove the temporary overlay directory.

    Safe to call even if the path does not exist.
    """
    overlay = Path(overlay_path)
    if overlay.exists():
        shutil.rmtree(overlay, ignore_errors=True)
        logger.info("Cleaned up overlay at %s", overlay)
