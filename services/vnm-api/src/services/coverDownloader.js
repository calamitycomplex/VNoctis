/**
 * Cover art downloader.
 *
 * Fetches a cover image URL and saves it locally under an application-owned
 * media root. Supports two storage identities:
 *
 *   game  -> <root>/<gameId>.jpg          (legacy, unchanged)
 *   title -> <root>/titles/<titleId>.jpg  (Title-owned, Slice F)
 *
 * Uses Node.js built-in `fetch` — no external dependencies.
 */

import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { coverMediaPaths, isContained, isValidEntityId } from './mediaPaths.js';

/**
 * Download a cover image for an entity (game or title).
 *
 * @param {object} options
 * @param {'game'|'title'} options.entityType
 * @param {string} options.entityId
 * @param {string} options.imageUrl   - Direct image URL from VNDB/Steam.
 * @param {string} options.rootPath   - Absolute path to the covers root (e.g. "/covers").
 * @returns {Promise<string|null>} Public cover path on success, null on failure.
 */
export async function downloadEntityCover({ entityType, entityId, imageUrl, rootPath }) {
  if (!imageUrl || !rootPath || !isValidEntityId(entityType, entityId)) return null;

  const { filePath, urlPath } = coverMediaPaths(rootPath, entityType, entityId);
  if (!isContained(rootPath, filePath)) return null;

  // If the file already exists, skip download
  try {
    await access(filePath);
    return urlPath;
  } catch {
    // File does not exist — proceed with download
  }

  try {
    await mkdir(dirname(filePath), { recursive: true });

    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(
        `[CoverDownloader] Failed to fetch cover for ${entityType}:${entityId}: ${res.status} ${res.statusText}`
      );
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(filePath, buffer);

    return urlPath;
  } catch (err) {
    console.error(
      `[CoverDownloader] Error downloading cover for ${entityType}:${entityId}:`,
      err.message
    );
    return null;
  }
}

/**
 * Remove an entity's cached cover file. Only the intended entity's file is
 * touched; sibling media is left alone.
 */
export async function removeEntityCover({ entityType, entityId, rootPath }) {
  if (!rootPath || !isValidEntityId(entityType, entityId)) return;

  const { filePath } = coverMediaPaths(rootPath, entityType, entityId);
  if (!isContained(rootPath, filePath)) return;

  try {
    await rm(filePath, { force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Legacy wrapper: download a cover keyed by a Game id.
 *
 * @param {string}  imageUrl   - Direct image URL.
 * @param {string}  gameId     - Game fingerprint ID.
 * @param {string}  coversPath - Absolute path to the covers directory.
 */
export async function downloadCover(imageUrl, gameId, coversPath) {
  return downloadEntityCover({ entityType: 'game', entityId: gameId, imageUrl, rootPath: coversPath });
}
