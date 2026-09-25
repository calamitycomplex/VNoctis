/**
 * Import staging and safe archive extraction.
 *
 * `GAMES_PATH` is authoritative archive storage and may be mounted read-only.
 * Import processing must therefore extract, chmod, and RPA-process inside an
 * application-owned staging root only. Nothing in this module writes beneath
 * `GAMES_PATH`.
 *
 * Staging root defaults to `${WEB_BUILDS_PATH}/imports` (override with
 * `IMPORT_STAGING_PATH`). `WEB_BUILDS_PATH` is the existing app-owned writable
 * volume already shared with the builder, so staged imports stay reachable
 * without adding a new mount.
 *
 * Archive safety strategy:
 *   - member names are validated before extraction: no absolute paths, no `..`
 *     segments;
 *   - link entries (symlink/hardlink) are checked so their target stays inside
 *     the extraction root;
 *   - after extraction every symlink in the produced tree must resolve inside
 *     staging (`assertWorkspaceSymlinksContained`);
 *   - archives whose member list cannot be inspected with entry-type metadata
 *     fail clearly instead of being extracted blind.
 *   - every import gets a unique staging directory, so same-titled imports
 *     never share or overwrite one another.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { pathExists } from './rpaExtractor.js';
import { assertWorkspaceSymlinksContained } from './buildWorkspace.js';

const execFileAsync = promisify(execFile);

// Large archives can produce substantial stdout.
const execOpts = { maxBuffer: 50 * 1024 * 1024 };

export const IMPORT_STAGING_DIRNAME = 'imports';

// ── Supported archive formats ──────────────────────────
// Order matters — longest suffix first so `.tar.bz2` matches before `.bz2`.
export const ARCHIVE_FORMATS = [
  { ext: '.tar.bz2', type: 'tar.bz2' },
  { ext: '.zip', type: 'zip' },
  { ext: '.rar', type: 'rar' },
];

export const ACCEPTED_EXTENSIONS = ARCHIVE_FORMATS.map((f) => f.ext);
export const ACCEPTED_LABEL = ACCEPTED_EXTENSIONS.join(', ');

/**
 * Detect the archive type from a filename.
 *
 * @param {string} filename
 * @returns {{ ext: string, type: string } | null}
 */
export function detectArchiveType(filename) {
  const lower = filename.toLowerCase();
  for (const fmt of ARCHIVE_FORMATS) {
    if (lower.endsWith(fmt.ext)) return fmt;
  }
  return null;
}

/**
 * Strip the archive extension from a filename, handling compound
 * extensions like `.tar.bz2`.
 *
 * @param {string} filename
 * @returns {string}
 */
export function stripArchiveExt(filename) {
  const fmt = detectArchiveType(filename);
  if (!fmt) return filename;
  return filename.slice(0, filename.length - fmt.ext.length);
}

/**
 * Sanitise a folder name — strip path traversal and dangerous characters.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitiseFolderName(name) {
  return String(name)
    .replace(/\.\./g, '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+/, '');
}

/**
 * Default import staging root.
 *
 * @param {string} basePath
 * @returns {string}
 */
export function importStagingRoot(basePath) {
  return join(basePath, IMPORT_STAGING_DIRNAME);
}

/**
 * Resolve the import staging root, preferring an explicit override.
 *
 * @param {{ basePath?: string, configuredPath?: string }} [options]
 * @returns {string}
 */
export function resolveImportStagingRoot({ basePath, configuredPath } = {}) {
  if (configuredPath) return configuredPath;
  return importStagingRoot(basePath || '/web-builds');
}

const normaliseArchivePath = (name) => String(name).replace(/\\/g, '/').trim();

/**
 * A member name is safe when it is relative and free of `..` segments.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeMemberName(name) {
  const n = normaliseArchivePath(name);
  if (!n) return false;
  if (n.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(n)) return false;
  return !n.split('/').includes('..');
}

/**
 * Whether a link target escapes the extraction root.
 *
 * Symlink targets are relative to the member's own directory; tar hardlink
 * targets are relative to the archive root.
 *
 * @param {{ name: string, target: string, rootRelative?: boolean }} params
 * @returns {boolean}
 */
export function linkTargetEscapes({ name, target, rootRelative = false }) {
  const t = normaliseArchivePath(target);
  if (!t) return false;
  if (t.startsWith('/') || /^[A-Za-z]:/.test(t)) return true;
  const base = rootRelative ? '' : posix.dirname(normaliseArchivePath(name));
  const resolved = posix.normalize(posix.join(base, t));
  return resolved === '..' || resolved.startsWith('../');
}

function unsafeArchiveError(message) {
  return Object.assign(new Error(message), { statusCode: 400, code: 'UNSAFE_ARCHIVE' });
}

/**
 * Validate a parsed member list before extraction.
 *
 * @param {Array<{ name: string, linkKind?: string|null, linkTarget?: string|null }>} members
 */
export function validateArchiveMembers(members) {
  for (const member of members) {
    const name = member && member.name;
    if (!name) {
      throw unsafeArchiveError('Archive contains an entry with an empty name.');
    }
    if (!isSafeMemberName(name)) {
      throw unsafeArchiveError(
        `Unsafe archive path "${name}" (absolute or traversal).`
      );
    }
    if (
      member.linkKind &&
      member.linkTarget &&
      linkTargetEscapes({
        name,
        target: member.linkTarget,
        rootRelative: member.linkKind === 'hardlink',
      })
    ) {
      throw unsafeArchiveError(
        `Unsafe ${member.linkKind} "${name}" -> "${member.linkTarget}" escapes the staging root.`
      );
    }
  }
}

/**
 * Parse `tar -tvjf` output.
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, linkKind: string|null, linkTarget: string|null }>}
 */
export function parseTarMemberList(stdout) {
  const members = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    const typeChar = line[0];
    if (typeChar === 'l' && line.includes(' -> ')) {
      const [left, target] = line.split(' -> ');
      members.push({ name: tarName(left), linkKind: 'symlink', linkTarget: target.trim() });
    } else if (typeChar === 'h' && line.includes(' link to ')) {
      const [left, target] = line.split(' link to ');
      members.push({ name: tarName(left), linkKind: 'hardlink', linkTarget: target.trim() });
    } else {
      members.push({ name: tarName(line), linkKind: null, linkTarget: null });
    }
  }
  return members.filter((m) => m.name);
}

// tar columns: mode owner size date time name...
function tarName(line) {
  const parts = line.trim().split(/\s+/);
  return parts.length > 5 ? parts.slice(5).join(' ') : parts[parts.length - 1];
}

/**
 * Parse `zipinfo` output, including symlink metadata.
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, linkKind: string|null, linkTarget: string|null }>}
 */
export function parseZipMemberList(stdout) {
  const members = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^-{3,}/.test(line)) continue; // listing separators
    if (!'-dl?'.includes(line[0])) continue;

    if (line.includes(' -> ')) {
      const [left, target] = line.split(' -> ');
      members.push({ name: listingName(left), linkKind: 'symlink', linkTarget: target.trim() });
    } else {
      members.push({ name: listingName(line), linkKind: null, linkTarget: null });
    }
  }
  return members.filter((m) => m.name);
}

function listingName(line) {
  const match = line.match(/\d{2}:\d{2}(?::\d{2})?\s+(.+)$/);
  if (match) return match[1].trim();
  const parts = line.trim().split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * Parse `7z l -slt` output. The first `Path` entry is the archive itself; the
 * caller drops it.
 *
 * @param {string} stdout
 * @returns {Array<{ name: string, linkKind: string|null, linkTarget: string|null }>}
 */
export function parse7zMemberList(stdout) {
  const members = [];
  let current = null;

  const flush = () => {
    if (current && current.name) members.push(current);
    current = null;
  };

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }

    const pathMatch = line.match(/^Path = (.+)$/);
    if (pathMatch) {
      flush();
      current = { name: pathMatch[1].trim(), linkKind: null, linkTarget: null };
      continue;
    }
    if (!current) continue;

    const symlinkMatch = line.match(/^Symbolic Link = (.+)$/);
    if (symlinkMatch) {
      current.linkKind = 'symlink';
      current.linkTarget = symlinkMatch[1].trim();
      continue;
    }
    const hardlinkMatch = line.match(/^Hard Link = (.+)$/);
    if (hardlinkMatch) {
      current.linkKind = 'hardlink';
      current.linkTarget = hardlinkMatch[1].trim();
    }
  }
  flush();
  return members;
}

/**
 * List archive members using the current toolchain. Throws if the archive
 * cannot be inspected with entry-type metadata, so extraction is never
 * performed blind.
 *
 * ZIP requires `zipinfo` (or equivalent metadata-capable listing). A name-only
 * listing such as `unzip -l` cannot identify symlink entries and is therefore
 * not an accepted safety fallback.
 *
 * @param {{ archivePath: string, type: string }} params
 * @returns {Promise<Array<{ name: string, linkKind: string|null, linkTarget: string|null }>>}
 */
export async function inspectArchiveMembers({ archivePath, type }) {
  try {
    if (type === 'tar.bz2') {
      const { stdout } = await execFileAsync('tar', ['-tvjf', archivePath], execOpts);
      return parseTarMemberList(stdout);
    }

    if (type === 'rar') {
      const { stdout } = await execFileAsync('7z', ['l', '-slt', archivePath], execOpts);
      // First Path entry is the archive itself.
      return parse7zMemberList(stdout).slice(1);
    }

    // zip — must use zipinfo so symlink metadata is available.
    const { stdout } = await execFileAsync('zipinfo', [archivePath], execOpts);
    return parseZipMemberList(stdout);
  } catch (err) {
    throw Object.assign(
      new Error(`Could not inspect archive members safely: ${err.message}`),
      { statusCode: 422, code: 'ARCHIVE_INSPECTION_FAILED' }
    );
  }
}

/**
 * Determine the single top-level folder name from a member list, if any.
 *
 * @param {Array<{ name: string }>} members
 * @returns {string|null}
 */
export function getSingleTopLevelFolderFromMembers(members) {
  if (!members || members.length === 0) return null;

  const topLevel = new Set();
  for (const member of members) {
    const norm = normaliseArchivePath(member.name);
    const first = norm.split('/')[0];
    if (first) topLevel.add(first);
  }

  if (topLevel.size !== 1) return null;
  const folder = [...topLevel][0];
  const hasChildren = members.some((member) => {
    const norm = normaliseArchivePath(member.name);
    return norm.startsWith(`${folder}/`) && norm !== `${folder}/`;
  });
  const isFolder =
    members.some((member) => normaliseArchivePath(member.name) === `${folder}/`) ||
    hasChildren;

  return isFolder ? folder : null;
}

async function extractArchiveInto({ archivePath, type, workPath }) {
  if (type === 'zip') {
    await execFileAsync('unzip', ['-o', archivePath, '-d', workPath], execOpts);
  } else if (type === 'tar.bz2') {
    await execFileAsync('tar', ['xjf', archivePath, '-C', workPath], execOpts);
  } else if (type === 'rar') {
    await execFileAsync('7z', ['x', archivePath, `-o${workPath}`, '-y'], execOpts);
  }
}

/**
 * Extract an archive into a unique application-owned import staging directory.
 *
 * The archive source and `GAMES_PATH` are never written. On any failure the
 * work directory and final staging directory for this import are removed, and
 * nothing else. The staging directory identity is derived from the inferred
 * name plus a unique suffix, so same-titled imports never collide.
 *
 * @param {{ archivePath: string, originalName: string, type: string, stagingRoot: string, logger?: object }} params
 * @returns {Promise<{ folderName: string, stagingId: string, path: string, singleFolder: string|null }>}
 */
export async function extractArchiveToStaging({
  archivePath,
  originalName,
  type,
  stagingRoot,
  logger,
}) {
  await mkdir(stagingRoot, { recursive: true });

  const members = await inspectArchiveMembers({ archivePath, type });
  validateArchiveMembers(members);

  const singleFolder = getSingleTopLevelFolderFromMembers(members);
  const folderName = sanitiseFolderName(singleFolder || stripArchiveExt(basename(originalName)));

  if (!folderName) {
    throw Object.assign(
      new Error('Could not determine a valid folder name from the archive.'),
      { statusCode: 400, code: 'INVALID_FOLDER_NAME' }
    );
  }

  // Unique per import: never derive directory identity from the name alone.
  const uniqueId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const stagingId = `${folderName}-${uniqueId}`;
  const finalPath = join(stagingRoot, stagingId);
  const workPath = join(stagingRoot, `.work-${uniqueId}`);

  logger?.info?.(
    { type, archivePath, singleFolder, stagingId },
    'Extracting archive into import staging'
  );

  try {
    await mkdir(workPath, { recursive: true });
    await extractArchiveInto({ archivePath, type, workPath });

    const produced = singleFolder ? join(workPath, singleFolder) : workPath;
    if (!(await pathExists(produced))) {
      throw Object.assign(
        new Error('Archive extraction did not produce the expected staging folder.'),
        { statusCode: 500, code: 'EXTRACTION_FAILED' }
      );
    }

    // Defense-in-depth: tools may materialise symlinks differently than listed.
    await assertWorkspaceSymlinksContained(produced);
    await rename(produced, finalPath);
  } catch (err) {
    // Clean up only the directories this specific import created.
    await rm(workPath, { recursive: true, force: true }).catch(() => {});
    await rm(finalPath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  // A single-folder archive leaves the (now empty) work dir behind.
  await rm(workPath, { recursive: true, force: true }).catch(() => {});

  logger?.info?.({ folderName, stagingId, path: finalPath }, 'Archive extracted into import staging');
  return { folderName, stagingId, path: finalPath, singleFolder };
}
