/**
 * Media storage path helpers.
 *
 * Media is stored beneath an application-owned media root. Two entity types
 * are supported:
 *
 *   game  -> <root>/<gameId>.jpg            (legacy, unchanged)
 *   title -> <root>/titles/<titleId>.jpg    (Title-owned, Slice F)
 *
 * Screenshots use a per-entity directory instead of a single filename.
 * These helpers only derive paths — no filesystem access, no downloads.
 */

import { join, resolve, sep } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate an entity id before it is used as a path segment.
 *
 * Title ids must be UUIDs. Game ids keep their existing (arbitrary but safe)
 * fingerprint format; they only have to be a single, traversal-free segment.
 */
export function isValidEntityId(entityType, entityId) {
  if (typeof entityId !== 'string' || !SAFE_ID_RE.test(entityId)) return false;
  if (entityId === '.' || entityId === '..') return false;
  if (entityType === 'title') return UUID_RE.test(entityId);
  return true;
}

/** Directory that holds an entity's media (adds the `titles/` segment for Titles). */
function entityDir(rootPath, entityType) {
  return entityType === 'title' ? join(rootPath, 'titles') : rootPath;
}

/** True when `targetPath` resolves at or beneath `rootPath`. */
export function isContained(rootPath, targetPath) {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  return target === root || target.startsWith(root + sep);
}

/** Cover file path + the public URL path that serves it. */
export function coverMediaPaths(rootPath, entityType, entityId) {
  const filePath = join(entityDir(rootPath, entityType), `${entityId}.jpg`);
  const urlPath = entityType === 'title'
    ? `/covers/titles/${entityId}.jpg`
    : `/covers/${entityId}.jpg`;
  return { filePath, urlPath };
}

/** Per-entity screenshot directory. */
export function screenshotDirPath(rootPath, entityType, entityId) {
  return join(entityDir(rootPath, entityType), entityId);
}

/** Screenshot file path + the public URL path that serves it. */
export function screenshotMediaPaths(rootPath, entityType, entityId, index) {
  const filePath = join(screenshotDirPath(rootPath, entityType, entityId), `${index}.jpg`);
  const urlPath = entityType === 'title'
    ? `/screenshots/titles/${entityId}/${index}.jpg`
    : `/screenshots/${entityId}/${index}.jpg`;
  return { filePath, urlPath };
}
