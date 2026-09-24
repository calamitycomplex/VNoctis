import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entrypointPath = join(here, 'docker-entrypoint.sh');

// Strip comments so that prose mentioning /games is not mistaken for a mutation.
function executableCommands(script) {
  return script
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

test('entrypoint does not create, chown, chmod, or delete anything under /games', async () => {
  const script = await readFile(entrypointPath, 'utf8');
  const commands = executableCommands(script);
  assert.doesNotMatch(commands, /\/games\b/, 'startup commands must not reference /games');
});

test('entrypoint still initializes application-owned writable paths', async () => {
  const script = await readFile(entrypointPath, 'utf8');
  assert.match(script, /mkdir -p [^\n]*\/data[^\n]*\/covers[^\n]*\/screenshots[^\n]*\/web-builds/);
  assert.match(script, /chown -R "\$PUID:\$PGID" \/data \/covers \/screenshots/);
  assert.match(script, /chown "\$PUID:\$PGID" \/web-builds/);
  assert.match(script, /find \/web-builds /);
});
