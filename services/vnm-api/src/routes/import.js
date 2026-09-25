import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractRpaArchives } from '../services/rpaExtractor.js';
import {
  ACCEPTED_LABEL,
  detectArchiveType,
  sanitiseFolderName,
  stripArchiveExt,
  resolveImportStagingRoot,
  extractArchiveToStaging,
} from '../services/importStaging.js';

const execFileAsync = promisify(execFile);

/**
 * Extract an archive into application-owned import staging.
 *
 * `GAMES_PATH` is authoritative and treated as read-only here: extraction,
 * chmod, and RPA processing all happen inside `stagingRoot`. Staged material is
 * not promoted into the archive and no `Game`/`ArchiveItem`/`Title` record is
 * created; that is made explicit by the returned `staged`/`promoted` flags.
 *
 * @param {string} tmpPath - Path to the temp archive file.
 * @param {string} originalName - Original filename (used for folder inference).
 * @param {string} stagingRoot - Application-owned import staging root.
 * @param {import('pino').Logger} logger
 * @returns {Promise<{ folderName: string, stagingId: string, path: string, staged: boolean, promoted: boolean }>}
 */
async function extractAndStage(tmpPath, originalName, stagingRoot, logger) {
  const archiveType = detectArchiveType(originalName);
  if (!archiveType) {
    throw Object.assign(new Error(`Unsupported archive format. Accepted: ${ACCEPTED_LABEL}`), {
      statusCode: 400,
      code: 'UNSUPPORTED_FORMAT',
    });
  }

  const { folderName, stagingId, path: extractedPath } = await extractArchiveToStaging({
    archivePath: tmpPath,
    originalName,
    type: archiveType.type,
    stagingRoot,
    logger,
  });

  // Permission normalisation applies only inside staging.
  try {
    await execFileAsync('chmod', ['-R', '777', extractedPath]);
  } catch (chmodErr) {
    logger.warn?.(
      { err: chmodErr.message, path: extractedPath },
      'Failed to fix permissions on staged import'
    );
  }

  // RPA extraction/removal applies only inside staging.
  await extractRpaArchives(extractedPath, logger);

  logger.info?.({ folderName, stagingId, path: extractedPath }, 'Archive staged for import');

  return { folderName, stagingId, path: extractedPath, staged: true, promoted: false };
}

/**
 * Import route plugin — handles archive upload, extraction, and scan trigger.
 * Supports .zip, .tar.bz2, and .rar archives.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function importRoutes(fastify) {
  // Application-owned writable staging root. Defaults to
  // `${WEB_BUILDS_PATH}/imports`; override with IMPORT_STAGING_PATH.
  const importStagingPath = resolveImportStagingRoot({
    basePath: process.env.WEB_BUILDS_PATH,
    configuredPath: process.env.IMPORT_STAGING_PATH,
  });

  /**
   * POST /library/import
   *
   * Accepts a multipart archive upload (.zip, .tar.bz2, or .rar) and extracts
   * it into application-owned import staging. The authoritative `GAMES_PATH`
   * archive is left untouched; staged material is not promoted into it yet.
   * A library scan of the authoritative archive is triggered afterwards.
   *
   * Archive structure handling:
   *   1. Single top-level folder → folder preserved in staging
   *   2. Multiple top-level entries → infer folder name from archive filename,
   *      create <staging>/<archiveName>/ and extract into it
   */
  const maxBodySize =
    (parseInt(process.env.MAX_IMPORT_SIZE_MB, 10) || 24576) * 1024 * 1024;

  fastify.post('/library/import', { bodyLimit: maxBodySize }, async (request, reply) => {
    let tmpPath = null;

    try {
      // ── 1. Receive the uploaded file ──────────────────
      const data = await request.file();

      if (!data) {
        return reply.code(400).send({
          code: 'NO_FILE',
          message: 'No file was uploaded. Please select an archive file.',
        });
      }

      const originalName = data.filename || 'import.zip';
      const archiveType = detectArchiveType(originalName);

      if (!archiveType) {
        data.file.resume();
        return reply.code(400).send({
          code: 'INVALID_FILE_TYPE',
          message: `Only ${ACCEPTED_LABEL} files are accepted.`,
        });
      }

      // ── 2. Stream upload to temp file ─────────────────
      const safeName = sanitiseFolderName(stripArchiveExt(basename(originalName))) || 'import';
      tmpPath = join(tmpdir(), `vnm-${safeName}-${Date.now()}${archiveType.ext}`);
      await pipeline(data.file, createWriteStream(tmpPath));

      const tmpStat = await stat(tmpPath);
      if (tmpStat.size === 0) {
        return reply.code(400).send({ code: 'EMPTY_FILE', message: 'The uploaded file is empty.' });
      }

      request.log.info({ filename: originalName, size: tmpStat.size, type: archiveType.type }, 'Archive file uploaded to temp');

      // ── 3. Extract into staging ───────────────────────
      const result = await extractAndStage(
        tmpPath,
        originalName,
        importStagingPath,
        request.log
      );

      return {
        folderName: result.folderName,
        stagingId: result.stagingId,
        path: result.path,
        staged: true,
        promoted: false,
        message:
          'Archive extracted into import staging. It is not promoted into the archive yet.',
      };
    } catch (err) {
      request.log.error({ err: err.message }, 'Import failed');
      if (err.statusCode) throw err;
      return reply.code(500).send({
        code: 'IMPORT_FAILED',
        message: err.message || 'An unexpected error occurred during import.',
      });
    } finally {
      if (tmpPath) {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    }
  });

  /**
   * POST /library/import-url
   *
   * Downloads an archive from a remote URL (.zip, .tar.bz2, or .rar) and
   * extracts it into application-owned import staging (GAMES_PATH untouched).
   * Streams NDJSON progress events back to the client.
   *
   * Body: { "url": "https://example.com/game.zip" }
   *
   * Response: streamed NDJSON lines:
   *   { "phase": "downloading", "progress": 0, "totalBytes": 123456 }
   *   { "phase": "downloading", "progress": 50, "downloadedBytes": 61728 }
   *   { "phase": "extracting" }
   *   { "phase": "complete", "folderName": "GameName" }
   *   { "phase": "error", "message": "..." }
   */
  fastify.post('/library/import-url', async (request, reply) => {
    const { url } = request.body || {};

    if (!url || typeof url !== 'string') {
      return reply.code(400).send({
        code: 'MISSING_URL',
        message: 'A "url" field is required in the request body.',
      });
    }

    // Validate URL format
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only http and https URLs are supported.');
      }
    } catch (urlErr) {
      return reply.code(400).send({
        code: 'INVALID_URL',
        message: urlErr.message || 'Invalid URL provided.',
      });
    }

    // Infer filename from URL path and detect archive type
    const urlPath = parsedUrl.pathname;
    let inferredName = basename(urlPath) || 'download.zip';
    let archiveType = detectArchiveType(inferredName);

    // If we can't detect the type from the URL, default to .zip
    if (!archiveType) {
      inferredName += '.zip';
      archiveType = detectArchiveType(inferredName);
    }

    // Set up NDJSON streaming response
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    });

    const sendEvent = (data) => {
      reply.raw.write(JSON.stringify(data) + '\n');
    };

    let tmpPath = null;

    try {
      // ── 1. Download the file ──────────────────────────
      sendEvent({ phase: 'downloading', progress: 0, message: `Downloading ${inferredName}…` });

      const response = await fetch(url, {
        headers: { 'User-Agent': 'VN-Manager/1.0' },
        redirect: 'follow',
      });

      if (!response.ok) {
        sendEvent({ phase: 'error', message: `Download failed: HTTP ${response.status} ${response.statusText}` });
        reply.raw.end();
        return;
      }

      const contentLength = parseInt(response.headers.get('content-length'), 10) || 0;
      const safeName = sanitiseFolderName(stripArchiveExt(basename(inferredName))) || 'download';
      tmpPath = join(tmpdir(), `vnm-${safeName}-${Date.now()}${archiveType.ext}`);
      const writeStream = createWriteStream(tmpPath);

      if (contentLength > 0) {
        sendEvent({ phase: 'downloading', progress: 0, totalBytes: contentLength });
      }

      // Stream download with progress tracking
      let downloadedBytes = 0;
      let lastReportedPct = -1;

      const progressStream = new Readable({
        // PassThrough-like: we'll pipe from response body
        read() {},
      });

      // Use the web ReadableStream from fetch
      const reader = response.body.getReader();

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            writeStream.end();
            break;
          }
          downloadedBytes += value.length;
          writeStream.write(value);

          // Report progress at each 1% increment (or every chunk if no content-length)
          if (contentLength > 0) {
            const pct = Math.round((downloadedBytes / contentLength) * 100);
            if (pct !== lastReportedPct) {
              lastReportedPct = pct;
              sendEvent({ phase: 'downloading', progress: pct, downloadedBytes, totalBytes: contentLength });
            }
          } else {
            // Unknown size — report bytes downloaded
            sendEvent({ phase: 'downloading', progress: -1, downloadedBytes });
          }
        }
      };

      await pump();

      // Wait for the write stream to finish flushing
      await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const tmpStat = await stat(tmpPath);
      if (tmpStat.size === 0) {
        sendEvent({ phase: 'error', message: 'Downloaded file is empty.' });
        reply.raw.end();
        return;
      }

      request.log.info(
        { url, filename: inferredName, size: tmpStat.size, type: archiveType.type },
        'URL download complete'
      );

      sendEvent({ phase: 'downloading', progress: 100, downloadedBytes: tmpStat.size, totalBytes: tmpStat.size });

      // ── 2. Extract into staging ───────────────────────
      sendEvent({ phase: 'extracting', message: 'Extracting into import staging…' });

      const result = await extractAndStage(
        tmpPath,
        inferredName,
        importStagingPath,
        request.log
      );

      sendEvent({
        phase: 'complete',
        folderName: result.folderName,
        stagingId: result.stagingId,
        path: result.path,
        staged: true,
        promoted: false,
        message:
          'Archive extracted into import staging. It is not promoted into the archive yet.',
      });
    } catch (err) {
      request.log.error({ err: err.message, url }, 'URL import failed');
      sendEvent({
        phase: 'error',
        message: err.message || 'An unexpected error occurred during URL import.',
      });
    } finally {
      if (tmpPath) {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
      reply.raw.end();
    }
  });
}
