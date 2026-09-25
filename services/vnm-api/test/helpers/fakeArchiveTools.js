/**
 * Test helper: install fake `unzip` / `zipinfo` / `tar` / `7z` binaries on PATH.
 *
 * Listing calls (`unzip -l`, `tar -tvjf`, `7z l -slt`) print the seeded
 * listing. Extraction calls copy a seeded contents directory into the target
 * directory, so tests can exercise staging without the real tools.
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const EXTRACT_FAIL_GUARD = `
[ "\${FAKE_EXTRACT_EXIT:-0}" != "0" ] && exit "\${FAKE_EXTRACT_EXIT}"
mkdir -p "$dest"
cp -a "$FAKE_ARCHIVE_CONTENTS/." "$dest/"
`;

const SCRIPTS = {
  zipinfo: `#!/bin/sh
[ "\${FAKE_ZIPINFO_EXIT:-0}" != "0" ] && exit "\${FAKE_ZIPINFO_EXIT}"
printf '%s\n' "$FAKE_ARCHIVE_LISTING"
exit 0
`,
  unzip: `#!/bin/sh
case "$*" in *"-l"*) printf '%s\n' "$FAKE_ARCHIVE_LISTING"; exit 0;; esac
dest=""; prev=""
for a in "$@"; do
  case "$prev" in -d) dest="$a";; esac
  prev="$a"
done
[ -n "$dest" ] || exit 0
${EXTRACT_FAIL_GUARD}
`,
  tar: `#!/bin/sh
case "$*" in *"tvjf"*) printf '%s\n' "$FAKE_ARCHIVE_LISTING"; exit 0;; esac
dest=""; prev=""
for a in "$@"; do
  case "$prev" in -C) dest="$a";; esac
  prev="$a"
done
[ -n "$dest" ] || exit 0
${EXTRACT_FAIL_GUARD}
`,
  '7z': `#!/bin/sh
case "$*" in *"-slt"*) printf '%s\n' "$FAKE_ARCHIVE_LISTING"; exit 0;; esac
dest=""
for a in "$@"; do
  case "$a" in -o*) dest="\${a#-o}";; esac
done
[ -n "$dest" ] || exit 0
${EXTRACT_FAIL_GUARD}
`,
};

/**
 * @param {{ listing: string, contentsDir: string, zipinfoExit?: number }} params
 * @returns {Promise<{ binDir: string, restore: () => Promise<void> }>}
 */
export async function installFakeArchiveTools({ listing, contentsDir, zipinfoExit = 0 }) {
  const binDir = await mkdtemp(join(tmpdir(), 'vnoctis-fake-archive-'));

  for (const [name, script] of Object.entries(SCRIPTS)) {
    const binPath = join(binDir, name);
    await writeFile(binPath, script);
    await chmod(binPath, 0o755);
  }

  const previous = {
    PATH: process.env.PATH,
    FAKE_ARCHIVE_LISTING: process.env.FAKE_ARCHIVE_LISTING,
    FAKE_ARCHIVE_CONTENTS: process.env.FAKE_ARCHIVE_CONTENTS,
    FAKE_ZIPINFO_EXIT: process.env.FAKE_ZIPINFO_EXIT,
  };
  process.env.PATH = `${binDir}${previous.PATH ? `:${previous.PATH}` : ''}`;
  process.env.FAKE_ARCHIVE_LISTING = listing;
  process.env.FAKE_ARCHIVE_CONTENTS = contentsDir;
  process.env.FAKE_ZIPINFO_EXIT = String(zipinfoExit);

  return {
    binDir,
    async restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(binDir, { recursive: true, force: true });
    },
  };
}
