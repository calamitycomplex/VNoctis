/**
 * Screenshot downloader.
 *
 * Fetches VNDB/Steam screenshot URLs and saves them locally under an
 * application-owned media root. Supports two storage identities:
 *
 *   game  -> <root>/<gameId>/0.jpg          (legacy, unchanged)
 *   title -> <root>/titles/<titleId>/0.jpg  (Title-owned, Slice F)
 *
 * Uses Node.js built-in `fetch` — no external dependencies.
 */

import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { screenshotDirPath, screenshotMediaPaths, isContained, isValidEntityId } from './mediaPaths.js';

/**
 * Download an array of screenshots for an entity.
 *
 * Existing files are skipped (idempotent). On individual download failure the
 * original remote URL is preserved so the UI can still render something.
 *
 * @param {object} options
 * @param {'game'|'title'} options.entityType
 * @param {string} options.entityId
 * @param {string[]} options.urls    - Direct image URLs.
 * @param {string} options.rootPath  - Absolute screenshots root (e.g. "/screenshots").
 * @returns {Promise<string[]>} Local public paths, or original URLs on failure.
 */
export async function downloadEntityScreenshots({ entityType, entityId, urls, rootPath }) {
  if (!urls?.length || !rootPath || !isValidEntityId(entityType, entityId)) return [];

  const dir = screenshotDirPath(rootPath, entityType, entityId);
  if (!isContained(rootPath, dir)) return [];

  await mkdir(dir, { recursive: true });

  const localPaths = [];

  for (let i = 0; i < urls.length; i++) {
    const { filePath, urlPath } = screenshotMediaPaths(rootPath, entityType, entityId, i);

    // If the file already exists, skip download
    try {
      await access(filePath);
      localPaths.push(urlPath);
      continue;
    } catch {
      // File does not exist — proceed with download
    }

    try {
      const res = await fetch(urls[i], {
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.error(
          `[ScreenshotDownloader] Failed to fetch screenshot ${i} for ${entityType}:${entityId}: ${res.status} ${res.statusText}`
        );
        localPaths.push(urls[i]);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(filePath, buffer);
      localPaths.push(urlPath);
    } catch (err) {
      console.error(
        `[ScreenshotDownloader] Error downloading screenshot ${i} for ${entityType}:${entityId}:`,
        err.message
      );
      localPaths.push(urls[i]);
    }
  }

  return localPaths;
}

/** Remove an entity's cached screenshot directory (only that entity's media). */
export async function removeEntityScreenshots({ entityType, entityId, rootPath }) {
  if (!rootPath || !isValidEntityId(entityType, entityId)) return;

  const dir = screenshotDirPath(rootPath, entityType, entityId);
  if (!isContained(rootPath, dir)) return;

  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Legacy wrapper: download screenshots keyed by a Game id.
 *
 * @param {string[]} urls
 * @param {string}   gameId
 * @param {string}   screenshotsPath
 */
export async function downloadScreenshots(urls, gameId, screenshotsPath) {
  return downloadEntityScreenshots({ entityType: 'game', entityId: gameId, urls, rootPath: screenshotsPath });
}

/** Legacy wrapper: remove cached screenshots for a Game. */
export async function removeScreenshots(gameId, screenshotsPath) {
  return removeEntityScreenshots({ entityType: 'game', entityId: gameId, rootPath: screenshotsPath });
}
