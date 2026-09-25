/**
 * Build workspace (staging) helper.
 *
 * A build must never mutate `Game.directoryPath` / the archive source, which
 * may be mounted read-only. Before handing work to the builder we copy the
 * game source into an isolated, application-owned staging workspace and run
 * `.rpa` extraction only there.
 *
 * Staging lives under the shared `${WEB_BUILDS_PATH}/staging` directory so the
 * builder container can read it. Cleanup helpers are guarded so they can only
 * ever remove paths inside that staging root.
 *
 * Symlink policy:
 * `fs.cp(..., { verbatimSymlinks: true })` copies each link's raw target
 * string. Relative targets are therefore re-resolved against the new workspace
 * location, so a link that escaped the source root (or an absolute link into
 * the archive) can resolve back outside the workspace. The builder may write
 * through such a link and mutate the authoritative archive. We keep verbatim
 * symlinks, but after copying we require every symlink to resolve inside the
 * workspace; an escaping link fails preparation rather than being preserved.
 */

import { cp, mkdir, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export const BUILD_STAGING_DIRNAME = 'staging';
export const DEFAULT_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Root directory that holds all temporary build workspaces.
 *
 * @param {string} basePath - WEB_BUILDS_PATH
 * @returns {string}
 */
export function buildStagingRoot(basePath) {
  return join(basePath, BUILD_STAGING_DIRNAME);
}

/**
 * Verify that every symlink in the workspace resolves inside the workspace.
 *
 * This is what makes it safe for the builder to write through source symlinks:
 * a link either stays inside the isolated copy, or preparation fails.
 *
 * @param {string} workspacePath
 * @returns {Promise<void>}
 */
export async function assertWorkspaceSymlinksContained(workspacePath) {
  const root = resolve(workspacePath);

  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);

      if (entry.isSymbolicLink()) {
        const target = await readlink(entryPath);

        let resolved;
        try {
          resolved = await realpath(entryPath);
        } catch {
          // Dangling link: resolve lexically so containment is still enforced.
          resolved = resolve(dirname(entryPath), target);
        }

        if (resolved !== root && !resolved.startsWith(root + sep)) {
          throw new Error(
            `Unsafe symlink in build workspace: ${entryPath} -> ${target} ` +
              `(resolves outside ${root})`
          );
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  };

  await walk(root);
}

/**
 * Copy a game source tree into a fresh staging workspace.
 *
 * The source path is only ever read. The workspace is created empty and filled
 * with a copy, so any later extraction/deletion happens in the copy. Symlinks
 * are preserved only when they resolve inside the workspace; see the module
 * header for the policy.
 *
 * @param {{ sourcePath: string, basePath: string, jobId: string, logger?: object }} params
 * @returns {Promise<string>} created workspace path
 */
export async function createBuildWorkspace({ sourcePath, basePath, jobId, logger }) {
  const root = buildStagingRoot(basePath);
  await mkdir(root, { recursive: true });

  const workspacePath = join(root, jobId);
  await rm(workspacePath, { recursive: true, force: true });

  try {
    await cp(sourcePath, workspacePath, { recursive: true, verbatimSymlinks: true });
    await assertWorkspaceSymlinksContained(workspacePath);
  } catch (err) {
    // Never leave a half-copied or unsafe workspace behind.
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  logger?.info?.({ sourcePath, workspacePath }, 'Created isolated build workspace');
  return workspacePath;
}

/**
 * Remove a single staging workspace. Refuses to delete anything outside the
 * staging root, so the game source can never be affected.
 *
 * @param {string|null} workspacePath
 * @param {{ basePath?: string, logger?: object }} [options]
 */
export async function cleanupBuildWorkspace(workspacePath, { basePath, logger } = {}) {
  if (!workspacePath) return;

  if (basePath) {
    const root = buildStagingRoot(basePath);
    const insideRoot = workspacePath === root || workspacePath.startsWith(root + sep);
    if (!insideRoot) {
      logger?.warn?.(
        { workspacePath, root },
        'Refusing to clean a path outside the build staging root'
      );
      return;
    }
  }

  await rm(workspacePath, { recursive: true, force: true });
  logger?.info?.({ workspacePath }, 'Removed build workspace');
}

/**
 * Best-effort removal of stale staging workspaces, so workspaces left behind by
 * completed builds do not accumulate. Never throws.
 *
 * @param {{ basePath: string, ttlMs?: number, logger?: object }} params
 */
export async function sweepStaleBuildWorkspaces({
  basePath,
  ttlMs = DEFAULT_WORKSPACE_TTL_MS,
  logger,
}) {
  const root = buildStagingRoot(basePath);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const cutoff = Date.now() - ttlMs;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspacePath = join(root, entry.name);
    try {
      const stats = await stat(workspacePath);
      if (stats.mtimeMs >= cutoff) continue;
      await rm(workspacePath, { recursive: true, force: true });
      logger?.info?.({ workspacePath }, 'Swept stale build workspace');
    } catch {
      // Best-effort: another build may be using it, or it vanished mid-scan.
    }
  }
}
