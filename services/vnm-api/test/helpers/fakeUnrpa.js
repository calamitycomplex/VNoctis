/**
 * Test helper: install a fake `unrpa` binary on PATH so extraction can be
 * exercised without the real archive tooling.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * @param {{ exitCode?: number }} [options]
 * @returns {Promise<{ binDir: string, restore: () => Promise<void> }>}
 */
export async function installFakeUnrpa({ exitCode = 0 } = {}) {
  const binDir = await mkdtemp(join(tmpdir(), 'vnoctis-fake-unrpa-'));
  const script = `#!/bin/sh
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) target="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$target" ]; then
  echo extracted > "$target/UNRPA_EXTRACTED"
fi
exit ${exitCode}
`;

  const binPath = join(binDir, 'unrpa');
  await writeFile(binPath, script);
  await chmod(binPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${previousPath ? `:${previousPath}` : ''}`;

  return {
    binDir,
    async restore() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(binDir, { recursive: true, force: true });
    },
  };
}
