/**
 * Per-user runtime state preparation (whole-tree Btrfs COW clone).
 *
 * Layout (all segments are DB-generated UUIDs, never usernames):
 *
 *   /srv/vn-runtime/users/<userId>/<browserRuntimeId>/
 *       runtime/   persistent writable COW clone of the frozen golden
 *       scratch/   disposable session scratch, reset on every preparation
 *
 * The golden is only READ here. Cloning uses `cp -a --reflink=always`, so the
 * initial copy is an O(1) Btrfs reflink and later writes stay as deltas. If the
 * filesystem cannot reflink, preparation FAILS by default rather than silently
 * falling back to a full copy, so a deployment cannot accidentally stop being
 * copy-on-write. Tests may opt into `reflinkMode: 'auto'` for tiny fixtures.
 *
 * Nothing here launches Kasm, allocates a session, or touches the archive.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { isContained, resolveGoldenPath, resolveWithin } from './runtimeManifest.js';

export const USER_RUNTIME_ROOT_DEFAULT = '/srv/vn-runtime/users';
export const SESSION_SCRATCH_NAME = 'scratch';
export const RUNTIME_TREE_NAME = 'runtime';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const runFile = promisify(execFile);

/** Structured error so callers/tests can branch on a stable code. */
export class RuntimePathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimePathError';
    this.code = code;
  }
}

/** True when `value` is a canonical UUID string (path-safe). */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function assertContained(root, target, code, label) {
  if (!isContained(root, target)) {
    throw new RuntimePathError(code, `${label} escapes its root (${target}).`);
  }
}

/** Directory holding one user's prepared runtimes. */
export function userRootDir(userRoot, userId) {
  if (!isUuid(userId)) throw new RuntimePathError('INVALID_USER_ID', 'userId must be a UUID.');
  return join(userRoot, userId);
}

/** Parent directory for one user + runtime pair. */
export function runtimeParentDir(userRoot, userId, browserRuntimeId) {
  if (!isUuid(browserRuntimeId)) {
    throw new RuntimePathError('INVALID_RUNTIME_ID', 'browserRuntimeId must be a UUID.');
  }
  return join(userRootDir(userRoot, userId), browserRuntimeId);
}

/** Persistent writable game tree for one user + runtime pair. */
export function runtimeTreeDir(userRoot, userId, browserRuntimeId) {
  return join(runtimeParentDir(userRoot, userId, browserRuntimeId), RUNTIME_TREE_NAME);
}

/** Disposable scratch directory for one user + runtime pair. */
export function sessionScratchDir(userRoot, userId, browserRuntimeId) {
  return join(runtimeParentDir(userRoot, userId, browserRuntimeId), SESSION_SCRATCH_NAME);
}

async function kindOf(p) {
  try {
    const s = await stat(p);
    return s.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/**
 * Prepare (or reuse) the writable runtime tree for one user + runtime pair.
 *
 * @param {object} options
 * @param {string} options.userRoot        Absolute user-runtime root.
 * @param {string} options.goldenRoot      Absolute golden root.
 * @param {object} options.manifest        Validated manifest (needs `.golden`).
 * @param {string} options.userId          Application user UUID.
 * @param {string} options.browserRuntimeId BrowserRuntime UUID.
 * @param {'always'|'auto'} [options.reflinkMode]
 * @param {Function} [options.runCommand]  Command runner (execFile-promise); injectable for tests.
 * @param {boolean} [options.resetScratch]
 * @returns {Promise<{parentDir,runtimeDir,scratchDir,created:boolean}>}
 */
export async function ensureUserRuntime({
  userRoot = USER_RUNTIME_ROOT_DEFAULT,
  goldenRoot,
  manifest,
  userId,
  browserRuntimeId,
  reflinkMode = 'always',
  runCommand = runFile,
  resetScratch = true,
} = {}) {
  // ── Identity validation ────────────────────────────────────────────────────
  if (!manifest || typeof manifest !== 'object') {
    throw new RuntimePathError('MISSING_MANIFEST', 'A manifest is required to prepare a runtime.');
  }
  const parentDir = runtimeParentDir(userRoot, userId, browserRuntimeId);
  const runtimeDir = join(parentDir, RUNTIME_TREE_NAME);
  const scratchDir = join(parentDir, SESSION_SCRATCH_NAME);
  assertContained(userRoot, parentDir, 'PARENT_ESCAPE', 'runtime parent');
  assertContained(userRoot, runtimeDir, 'RUNTIME_ESCAPE', 'runtime tree');
  assertContained(userRoot, scratchDir, 'SCRATCH_ESCAPE', 'scratch dir');

  // ── Golden resolution + existence ──────────────────────────────────────────
  const goldenPath = resolveGoldenPath(goldenRoot, manifest.golden);
  if (!goldenPath) {
    throw new RuntimePathError('INVALID_GOLDEN', `golden "${manifest.golden}" is not a safe directory name.`);
  }
  assertContained(goldenRoot, goldenPath, 'GOLDEN_ESCAPE', 'golden path');
  if ((await kindOf(goldenPath)) !== 'dir') {
    throw new RuntimePathError('GOLDEN_MISSING', `Golden directory not found: ${goldenPath}`);
  }

  // ── Reuse or clone ─────────────────────────────────────────────────────────
  await mkdir(parentDir, { recursive: true });

  let created = false;
  if ((await kindOf(runtimeDir)) !== 'dir') {
    const tempDir = join(parentDir, `.runtime.tmp-${randomBytes(6).toString('hex')}`);
    // Never leave a half-cloned tree where a valid runtime is expected.
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });

    try {
      // `golden/.` copies contents, not the directory itself. (A trailing `/.`
      // is significant, so build the strings directly — path.join would drop it.)
      await runCommand('cp', ['-a', `--reflink=${reflinkMode}`, `${goldenPath}/.`, `${tempDir}/.`]);
      await rename(tempDir, runtimeDir);
      created = true;
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
      throw new RuntimePathError(
        'CLONE_FAILED',
        `COW clone failed (reflink=${reflinkMode}): ${err.message}`,
      );
    }
  }

  // ── Scratch ────────────────────────────────────────────────────────────────
  if (resetScratch) {
    await rm(scratchDir, { recursive: true, force: true });
  }
  await mkdir(scratchDir, { recursive: true });

  return { parentDir, runtimeDir, scratchDir, created };
}

/** Remove a prepared runtime tree for one user + runtime pair (admin cleanup). */
export async function removeUserRuntime({ userRoot = USER_RUNTIME_ROOT_DEFAULT, userId, browserRuntimeId } = {}) {
  const parentDir = runtimeParentDir(userRoot, userId, browserRuntimeId);
  assertContained(userRoot, parentDir, 'PARENT_ESCAPE', 'runtime parent');
  await rm(parentDir, { recursive: true, force: true });
  return { parentDir, removed: true };
}

/**
 * Lightweight golden immutability fingerprint.
 *
 * Full recursive hashing of a multi-GB golden is far too slow for every launch,
 * so this snapshots directory metadata plus a small caller-supplied set of
 * save-sensitive paths and hashes only regular files among them. Combine with
 * the read-only mount contract for a strong guarantee, and use a heavier
 * one-time recursive fingerprint during a real end-to-end rehearsal.
 *
 * @param {object} options
 * @param {string} options.goldenPath
 * @param {string[]} [options.sensitivePaths] Relative paths inside the golden (bounded to 32).
 */
export async function fingerprintGolden({ goldenPath, sensitivePaths = [] } = {}) {
  const goldenStat = await stat(goldenPath);
  const entries = [];
  for (const rel of sensitivePaths.slice(0, 32)) {
    const abs = resolveWithin(goldenPath, rel);
    if (!abs) {
      entries.push({ path: rel, missing: true });
      continue;
    }
    try {
      const s = await stat(abs);
      if (s.isFile()) {
        const { readFile } = await import('node:fs/promises');
        const hash = createHash('sha256').update(await readFile(abs)).digest('hex');
        entries.push({ path: rel, type: 'file', size: s.size, mtimeMs: s.mtimeMs, sha256: hash });
      } else {
        entries.push({ path: rel, type: 'dir', size: s.size, mtimeMs: s.mtimeMs });
      }
    } catch {
      entries.push({ path: rel, missing: true });
    }
  }
  return {
    goldenPath: resolve(goldenPath),
    golden: { size: goldenStat.size, mtimeMs: goldenStat.mtimeMs },
    entries,
  };
}

/** Containment helper re-exported for callers deriving paths. */
export { isContained, sep };
