"""Tests that every builder mode stages a private workspace and never writes
into the supplied game_path."""

import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

if "httpx" not in sys.modules:
    sys.modules["httpx"] = types.ModuleType("httpx")

from builder import RenPyBuilder  # noqa: E402


class _FakeStream:
    def __init__(self, data: bytes = b""):
        self._data = data
        self._done = False

    async def read(self, _n: int) -> bytes:
        if self._done:
            return b""
        self._done = True
        return self._data


class _FakeProc:
    def __init__(self, output_dir: Path):
        self.returncode = 0
        self.pid = 4242
        self.stdout = _FakeStream(b"[fake web_build]\n")
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "index.html").write_text("<html></html>")

    async def wait(self):
        return 0

    def send_signal(self, _sig):
        pass

    def kill(self):
        pass


class BuilderModeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.game = self.root / "MyGame"
        (self.game / "game").mkdir(parents=True)
        (self.game / "game" / "script.rpy").write_text("label start:")
        self.web_builds = self.root / "web-builds"
        self.work = self.root / "work"

        self._prev_env = dict()
        for key, val in {
            "BUILD_WORK_PATH": str(self.work),
            "COMPRESS_WORKERS": "1",
        }.items():
            self._prev_env[key] = __import__("os").environ.get(key)
            __import__("os").environ[key] = val

        self.commands = []

        async def fake_create_subprocess_exec(*cmd, **kwargs):
            self.commands.append(cmd)
            dest = Path(cmd[cmd.index("--destination") + 1])
            return _FakeProc(dest)

        self._patch = mock.patch(
            "asyncio.create_subprocess_exec",
            side_effect=fake_create_subprocess_exec,
        )
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        import os

        for key, val in self._prev_env.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
        self._tmp.cleanup()

    def _builder(self) -> RenPyBuilder:
        import os

        os.environ["BUILD_WORK_PATH"] = str(self.work)
        b = RenPyBuilder(
            sdk_path=str(self.root / "sdk"),
            games_path=str(self.root / "games"),
            web_builds_path=str(self.web_builds),
            api_url="http://api.test",
        )
        b._resolve_launcher = lambda: "/bin/true"

        async def _noop(*_a, **_k):
            return None

        b._notify_api_status = _noop
        return b

    def _build_source_from_last_cmd(self) -> str:
        cmd = self.commands[-1]
        return cmd[cmd.index("web_build") + 1]

    async def test_uncompressed_build_uses_private_workspace_and_no_source_marker(self):
        b = self._builder()
        await b.build_game(
            "job1", "game1", str(self.game),
            log_callback=lambda line: asyncio.sleep(0),
            compress_assets=False,
        )

        # progressive_download.txt never lands in the input tree.
        self.assertFalse((self.game / "progressive_download.txt").exists())

        build_source = Path(self._build_source_from_last_cmd())
        self.assertNotEqual(str(build_source), str(self.game))
        self.assertTrue(str(build_source).startswith(str(self.work)))

        # Workspace is cleaned up after the build.
        leftovers = list(self.work.glob("build-job1*"))
        self.assertEqual(leftovers, [])

    async def test_compression_enabled_build_still_uses_private_workspace(self):
        b = self._builder()
        await b.build_game(
            "job2", "game2", str(self.game),
            log_callback=lambda line: asyncio.sleep(0),
            compress_assets=True,
        )

        self.assertFalse((self.game / "progressive_download.txt").exists())

        build_source = Path(self._build_source_from_last_cmd())
        self.assertNotEqual(str(build_source), str(self.game))
        self.assertTrue(str(build_source).startswith(str(self.work)))

    async def test_failed_workspace_preparation_does_not_fall_back_to_source(self):
        b = self._builder()
        # Broken symlink makes staging fail.
        (self.game / "broken.txt").symlink_to("missing.txt")

        with self.assertRaises(RuntimeError):
            await b.build_game(
                "job3", "game3", str(self.game),
                log_callback=lambda line: asyncio.sleep(0),
                compress_assets=False,
            )

        # No fallback build was launched from the source path.
        self.assertEqual(self.commands, [])
        self.assertFalse((self.game / "progressive_download.txt").exists())
        self.assertEqual((self.game / "game" / "script.rpy").read_text(), "label start:")


if __name__ == "__main__":
    unittest.main()
