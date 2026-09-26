/**
 * Runtime manifest contract for prepared browser-play runtimes.
 *
 * A manifest is an admin-owned JSON document stored OUTSIDE the immutable golden
 * tree, e.g. /srv/vn-runtime/manifests/<manifestId>.json. It tells the launch
 * adapter which frozen golden to run, which runner image to use, what executable
 * to start, and how to make the session writable (whole-tree COW clone).
 *
 * Golden contents are never mutated to carry metadata: the manifest lives in a
 * sibling root and references the golden by a single allow-listed directory name.
 *
 * This module is deliberately storage-shape + validation only. It performs no
 * cloning, no Kasm calls and no writes.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export const MANIFEST_VERSION = 1;
export const MANIFEST_ROOT_DEFAULT = '/srv/vn-runtime/manifests';
export const GOLDEN_ROOT_DEFAULT = '/srv/vn-runtime/golden';
export const SAVE_STRATEGIES = ['whole-tree-cow'];
export const DEFAULT_ALLOWED_RUNNER_IMAGES = ['vn-runner-noble:1.19.0'];

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINE_EXE_RE = /\.exe$/i;

/** True when `target` resolves at or beneath `root`. */
export function isContained(root, target) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

/**
 * A golden reference is a single directory NAME beneath GOLDEN_ROOT.
 * It may contain spaces (e.g. "Kinkoi Golden Loveriche") but never a separator,
 * a drive letter, a leading slash, or a traversal segment.
 */
export function isSafeGoldenId(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('\0')) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  return true;
}

/** A relative path inside a runtime tree: no leading slash, no `..` segment. */
export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  const segments = value.split(/[\\/]+/);
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Manifest id is a single safe filename segment (no extension required). */
export function isSafeManifestId(value) {
  return isSafeGoldenId(value);
}

/** Absolute path of a manifest document, contained under `manifestRoot`. */
export function manifestFilePath(manifestRoot, manifestId) {
  if (!isSafeManifestId(manifestId)) return null;
  const filePath = join(manifestRoot, `${manifestId}.json`);
  return isContained(manifestRoot, filePath) ? filePath : null;
}

/** Resolve a golden id to an absolute path beneath `goldenRoot`. */
export function resolveGoldenPath(goldenRoot, goldenId) {
  if (!isSafeGoldenId(goldenId)) return null;
  const goldenPath = join(goldenRoot, goldenId);
  return isContained(goldenRoot, goldenPath) ? goldenPath : null;
}

/** Resolve a relative entrypoint/working-dir path beneath a runtime tree. */
export function resolveWithin(root, relativePath) {
  if (!isSafeRelativePath(relativePath)) return null;
  const target = resolve(root, relativePath);
  return isContained(root, target) ? target : null;
}

async function pathKind(p) {
  try {
    const s = await stat(p);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch {
    return null;
  }
}

/**
 * Load and JSON-parse a manifest document.
 *
 * @returns {Promise<{manifest: object|null, error: object|null, manifestPath: string|null}>}
 */
export async function loadManifest(manifestId, { manifestRoot = MANIFEST_ROOT_DEFAULT } = {}) {
  const manifestPath = manifestFilePath(manifestRoot, manifestId);
  if (!manifestPath) {
    return { manifest: null, manifestPath: null, error: { code: 'INVALID_MANIFEST_ID', message: 'manifestId is not a safe filename segment.' } };
  }
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch {
    return { manifest: null, manifestPath, error: { code: 'MANIFEST_NOT_FOUND', message: `No manifest at ${manifestPath}.` } };
  }
  try {
    const manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { manifest: null, manifestPath, error: { code: 'MALFORMED_MANIFEST', message: 'Manifest root must be a JSON object.' } };
    }
    return { manifest, manifestPath, error: null };
  } catch (err) {
    return { manifest: null, manifestPath, error: { code: 'MALFORMED_MANIFEST', message: `Manifest is not valid JSON: ${err.message}` } };
  }
}

/**
 * Validate a manifest against the filesystem and the configured allow-lists.
 *
 * @returns {Promise<{valid: boolean, errors: Array<{code,message}>, resolved: object|null}>}
 */
export async function validateManifest(manifest, {
  runtimeId = null,
  goldenRoot = GOLDEN_ROOT_DEFAULT,
  allowedRunnerImages = DEFAULT_ALLOWED_RUNNER_IMAGES,
} = {}) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: [{ code: 'MALFORMED_MANIFEST', message: 'Manifest must be a JSON object.' }], resolved: null };
  }

  if (manifest.version !== MANIFEST_VERSION) {
    errors.push({ code: 'UNSUPPORTED_VERSION', message: `manifest.version must be ${MANIFEST_VERSION}.` });
  }

  if (manifest.browserRuntimeId != null && runtimeId != null && manifest.browserRuntimeId !== runtimeId) {
    errors.push({ code: 'RUNTIME_ID_MISMATCH', message: 'manifest.browserRuntimeId does not match the BrowserRuntime.' });
  }

  if (!isSafeGoldenId(manifest.golden)) {
    errors.push({ code: 'INVALID_GOLDEN', message: 'golden must be a single safe directory name.' });
  }
  if (typeof manifest.runnerImage !== 'string' || !allowedRunnerImages.includes(manifest.runnerImage)) {
    errors.push({ code: 'UNKNOWN_RUNNER_IMAGE', message: `runnerImage "${manifest.runnerImage}" is not allow-listed.` });
  }
  if (!SAVE_STRATEGIES.includes(manifest.saveStrategy)) {
    errors.push({ code: 'UNKNOWN_SAVE_STRATEGY', message: `saveStrategy must be one of ${SAVE_STRATEGIES.join(', ')}.` });
  }

  if (manifest.winePrefix != null && !isSafeRelativePath(manifest.winePrefix)) {
    errors.push({ code: 'INVALID_WINE_PREFIX', message: 'winePrefix must be a safe relative path (or null).' });
  }

  const workingDir = manifest.workingDir == null ? '.' : manifest.workingDir;
  if (workingDir !== '.' && !isSafeRelativePath(workingDir)) {
    errors.push({ code: 'INVALID_WORKING_DIR', message: 'workingDir must be a safe relative path.' });
  }

  if (!isSafeRelativePath(manifest.entrypoint)) {
    errors.push({ code: 'INVALID_ENTRYPOINT', message: 'entrypoint must be a safe relative path.' });
  }

  if (manifest.env != null) {
    if (typeof manifest.env !== 'object' || Array.isArray(manifest.env)) {
      errors.push({ code: 'INVALID_ENV', message: 'env must be an object of string values.' });
    } else {
      for (const [key, value] of Object.entries(manifest.env)) {
        if (!ENV_KEY_RE.test(key) || typeof value !== 'string') {
          errors.push({ code: 'INVALID_ENV', message: `env entry "${key}" must be a safe name with a string value.` });
        }
      }
    }
  }

  if (manifest.locale != null && typeof manifest.locale !== 'string') {
    errors.push({ code: 'INVALID_LOCALE', message: 'locale must be a string or null.' });
  }

  if (errors.length > 0) {
    return { valid: false, errors, resolved: null };
  }

  // ── Filesystem checks (only once shape is known good) ──────────────────────
  const goldenPath = resolveGoldenPath(goldenRoot, manifest.golden);
  const goldenKind = goldenPath ? await pathKind(goldenPath) : null;
  if (goldenKind !== 'dir') {
    errors.push({ code: 'GOLDEN_MISSING', message: `Golden directory not found under ${goldenRoot}.` });
  }

  let entrypointPath = null;
  let winePrefixPath = null;
  let workingDirPath = null;

  if (goldenKind === 'dir') {
    entrypointPath = resolveWithin(goldenPath, manifest.entrypoint);
    if (!entrypointPath || (await pathKind(entrypointPath)) !== 'file') {
      errors.push({ code: 'ENTRYPOINT_MISSING', message: 'entrypoint does not resolve to a file inside the golden.' });
    }
    if (!WINE_EXE_RE.test(manifest.entrypoint)) {
      errors.push({ code: 'ENTRYPOINT_NOT_WINE_EXE', message: 'entrypoint should be a Windows .exe for the Wine runner.' });
    }

    if (workingDir && workingDir !== '.') {
      workingDirPath = resolveWithin(goldenPath, workingDir);
      if (!workingDirPath || (await pathKind(workingDirPath)) !== 'dir') {
        errors.push({ code: 'WORKING_DIR_MISSING', message: 'workingDir does not resolve to a directory inside the golden.' });
      }
    } else {
      workingDirPath = goldenPath;
    }

    if (manifest.winePrefix != null) {
      winePrefixPath = resolveWithin(goldenPath, manifest.winePrefix);
      if (!winePrefixPath || (await pathKind(winePrefixPath)) !== 'dir') {
        errors.push({ code: 'WINE_PREFIX_MISSING', message: 'winePrefix does not resolve to a directory inside the golden.' });
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, resolved: null };
  }

  return {
    valid: true,
    errors: [],
    resolved: {
      goldenPath,
      entrypointPath,
      workingDirPath,
      winePrefixPath,
    },
  };
}

/**
 * Derive the Wine launch command for a validated manifest.
 *
 * Kinkoi is a portable Unity folder, so the conventional invocation is
 * `wine <entrypoint>` from the working directory with a runtime-local
 * WINEPREFIX. When the manifest provides an explicit winePrefix, that prefix is
 * used instead. This is the only place a shell command is derived, so the
 * manifest itself stays declarative.
 */
export function buildLaunchCommand(manifest) {
  const workingDir = manifest.workingDir && manifest.workingDir !== '.' ? manifest.workingDir : null;
  const prefix = manifest.winePrefix ? `WINEPREFIX="${manifest.winePrefix}" ` : '';
  const entry = workingDir ? `${workingDir}/${manifest.entrypoint}` : manifest.entrypoint;
  return `wine ${prefix}${entry}`.trim();
}
