"""Tests for the private build workspace staging helper."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from build_workspace import (  # noqa: E402
    cleanup_workspace,
    resolve_work_root,
    stage_input_tree,
    workspace_paths,
)


class BuildWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.source = self.root / "source"
        self.work = self.root / "work"
        self.source.mkdir()
        self.work.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def _source_snapshot(self):
        """Relative path -> content/type snapshot, to prove the source is unchanged."""
        snapshot = {}
        for path in sorted(self.source.rglob("*")):
            rel = path.relative_to(self.source).as_posix()
            if path.is_symlink():
                snapshot[rel] = ("symlink", os.readlink(path))
            elif path.is_dir():
                snapshot[rel] = ("dir", None)
            elif path.is_file():
                snapshot[rel] = ("file", path.read_bytes())
            else:
                snapshot[rel] = ("special", None)
        return snapshot

    def test_stage_dereferences_file_symlink_into_independent_copy(self):
        (self.source / "real.txt").write_text("ORIGINAL")
        (self.source / "link.txt").symlink_to("real.txt")

        workspace = stage_input_tree(self.source, self.work / "ws")

        staged = workspace / "link.txt"
        self.assertFalse(staged.is_symlink())
        self.assertEqual(staged.read_text(), "ORIGINAL")

        # Writing through the workspace cannot touch the source file.
        staged.write_text("CHANGED")
        self.assertEqual((self.source / "real.txt").read_text(), "ORIGINAL")
        self.assertEqual((self.source / "link.txt").read_text(), "ORIGINAL")

        # The completed workspace contains no symlinks at all.
        self.assertEqual([p for p in workspace.rglob("*") if p.is_symlink()], [])

    def test_out_of_tree_file_symlink_is_rejected_and_source_unchanged(self):
        outside = self.root / "outside.txt"
        outside.write_text("OUTSIDE")
        (self.source / "escape.txt").symlink_to(outside)
        before = self._source_snapshot()

        with self.assertRaises(RuntimeError) as ctx:
            stage_input_tree(self.source, self.work / "ws")

        self.assertIn("escapes build source root", str(ctx.exception))
        self.assertEqual(outside.read_text(), "OUTSIDE")
        self.assertEqual(self._source_snapshot(), before)
        # Partial workspace cleaned up.
        self.assertFalse((self.work / "ws").exists())

    def test_out_of_tree_directory_symlink_is_rejected_and_source_unchanged(self):
        outside_dir = self.root / "outside_dir"
        outside_dir.mkdir()
        (outside_dir / "f.txt").write_text("OUTSIDE")
        (self.source / "escape_dir").symlink_to(outside_dir)
        before = self._source_snapshot()

        with self.assertRaises(RuntimeError) as ctx:
            stage_input_tree(self.source, self.work / "ws")

        self.assertIn("escapes build source root", str(ctx.exception))
        self.assertEqual((outside_dir / "f.txt").read_text(), "OUTSIDE")
        self.assertEqual(self._source_snapshot(), before)
        self.assertFalse((self.work / "ws").exists())

    def test_stage_dereferences_directory_symlink(self):
        (self.source / "real_dir").mkdir()
        (self.source / "real_dir" / "f.txt").write_text("DIR-FILE")
        (self.source / "link_dir").symlink_to("real_dir")

        workspace = stage_input_tree(self.source, self.work / "ws")

        staged_dir = workspace / "link_dir"
        self.assertFalse(staged_dir.is_symlink())
        self.assertTrue(staged_dir.is_dir())
        self.assertEqual((staged_dir / "f.txt").read_text(), "DIR-FILE")

    def test_broken_symlink_fails_staging(self):
        (self.source / "broken.txt").symlink_to("does-not-exist.txt")
        before = self._source_snapshot()

        with self.assertRaises(RuntimeError) as ctx:
            stage_input_tree(self.source, self.work / "ws")

        self.assertIn("Broken symlink", str(ctx.exception))
        self.assertEqual(self._source_snapshot(), before)
        self.assertFalse((self.work / "ws").exists())

    def test_directory_symlink_cycle_is_rejected_without_runaway_recursion(self):
        (self.source / "a").mkdir()
        (self.source / "a" / "link").symlink_to("..")
        before = self._source_snapshot()

        with self.assertRaises(RuntimeError) as ctx:
            stage_input_tree(self.source, self.work / "ws")

        self.assertIn("cycle", str(ctx.exception))
        self.assertEqual(self._source_snapshot(), before)
        self.assertFalse((self.work / "ws").exists())

    def test_self_referential_directory_symlink_cycle_is_rejected(self):
        (self.source / "dir").mkdir()
        (self.source / "dir" / "self").symlink_to(".")

        with self.assertRaises(RuntimeError) as ctx:
            stage_input_tree(self.source, self.work / "ws")

        self.assertIn("cycle", str(ctx.exception))

    def test_unsupported_special_entry_fifo_is_rejected(self):
        fifo = self.source / "pipe"
        try:
            os.mkfifo(fifo)
        except (AttributeError, OSError):
            self.skipTest("mkfifo not available")
        before = self._source_snapshot()

        with self.assertRaises(RuntimeError) as ctx:
            stage_input_tree(self.source, self.work / "ws")

        self.assertIn("Unsupported special entry", str(ctx.exception))
        self.assertEqual(self._source_snapshot(), before)
        self.assertFalse((self.work / "ws").exists())

    def test_stage_replaces_existing_workspace(self):
        (self.source / "a.txt").write_text("A")
        workspace = self.work / "ws"
        workspace.mkdir()
        (workspace / "stale.txt").write_text("STALE")

        stage_input_tree(self.source, workspace)

        self.assertFalse((workspace / "stale.txt").exists())
        self.assertEqual((workspace / "a.txt").read_text(), "A")

    def test_cleanup_removes_only_the_given_workspace(self):
        keep = self.work / "keep"
        keep.mkdir()
        ws = self.work / "build-job"
        stage_input_tree(self.source, ws)

        cleanup_workspace(ws)

        self.assertFalse(ws.exists())
        self.assertTrue(keep.exists())

    def test_workspace_paths_and_work_root(self):
        ws, overlay = workspace_paths(self.work, "job1")
        self.assertEqual(ws, self.work / "build-job1")
        self.assertEqual(overlay, self.work / "build-job1-overlay")
        self.assertEqual(resolve_work_root({"BUILD_WORK_PATH": "/custom"}), Path("/custom"))


if __name__ == "__main__":
    unittest.main()
