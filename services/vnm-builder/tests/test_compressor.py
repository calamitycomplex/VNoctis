"""Tests for compressor copy/symlink safety and output-collision planning."""

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from compressor import _plan_image_jobs, create_compressed_overlay  # noqa: E402


class CompressorSafetyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.source = self.root / "source"
        self.overlay = self.root / "overlay"
        self.source.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def test_non_image_files_are_independent_copies_not_symlinks(self):
        (self.source / "notes.txt").write_text("SOURCE-NOTES")
        (self.source / "sub").mkdir()
        (self.source / "sub" / "data.bin").write_bytes(b"BINARY")

        asyncio.run(create_compressed_overlay(str(self.source), str(self.overlay)))

        for rel in ("notes.txt", "sub/data.bin"):
            dst = self.overlay / rel
            self.assertTrue(dst.exists())
            self.assertFalse(dst.is_symlink())

        # A later write in the overlay cannot change the source.
        (self.overlay / "notes.txt").write_text("OVERLAY-NOTES")
        self.assertEqual((self.source / "notes.txt").read_text(), "SOURCE-NOTES")
        self.assertEqual((self.overlay / "sub" / "data.bin").read_bytes(), b"BINARY")

    def test_skipped_or_failed_image_compression_uses_a_copy_not_symlink(self):
        # pngquant may or may not be installed here; either way the overlay
        # entry must be an independent file, never a source-backed symlink.
        (self.source / "pic.png").write_bytes(b"PNG-BYTES")

        asyncio.run(create_compressed_overlay(str(self.source), str(self.overlay)))

        staged = self.overlay / "pic.png"
        self.assertTrue(staged.exists())
        self.assertFalse(staged.is_symlink())

        staged.write_bytes(b"OVERLAY-PNG")
        self.assertEqual((self.source / "pic.png").read_bytes(), b"PNG-BYTES")

    def test_bmp_secondary_png_is_skipped_when_another_png_owns_the_path(self):
        (self.source / "foo.bmp").write_bytes(b"BMP")
        (self.source / "foo.png").write_bytes(b"PNG")

        jobs, copies = _plan_image_jobs(self.source, self.overlay)

        destinations = []
        for _src, dst, _ext, secondary in jobs:
            destinations.append(dst)
            if secondary is not None:
                destinations.append(secondary)

        # Every destination is owned by exactly one job.
        self.assertEqual(len(destinations), len(set(destinations)))
        self.assertEqual(copies, [])

        bmp_secondary = next(
            secondary for _src, dst, ext, secondary in jobs
            if ext == ".bmp"
        )
        self.assertIsNone(bmp_secondary)

    def test_bmp_without_png_sibling_claims_its_derived_png(self):
        (self.source / "foo.bmp").write_bytes(b"BMP")

        jobs, _copies = _plan_image_jobs(self.source, self.overlay)

        _src, dst, ext, secondary = jobs[0]
        self.assertEqual(ext, ".bmp")
        self.assertEqual(secondary, dst.with_suffix(".png"))


if __name__ == "__main__":
    unittest.main()
