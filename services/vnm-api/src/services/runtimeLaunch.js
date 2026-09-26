/**
 * Launch-readiness gate for a prepared browser runtime.
 *
 * `canLaunch` answers a single question without side effects: given a persisted
 * BrowserRuntime row, is it actually launchable? It requires the workflow state
 * to be READY, a manifest reference to exist, and that manifest to validate
 * against the real filesystem and the configured runner-image allow-list.
 *
 * This does NOT change the admin READY transition and does NOT prepare state or
 * call Kasm; a later slice can tighten the READY transition on this contract.
 */

import {
  DEFAULT_ALLOWED_RUNNER_IMAGES,
  GOLDEN_ROOT_DEFAULT,
  MANIFEST_ROOT_DEFAULT,
  loadManifest,
  validateManifest,
} from './runtimeManifest.js';

export const LAUNCH_BLOCK_REASONS = {
  NOT_READY: 'Runtime workflow state is not READY.',
  NO_MANIFEST: 'BrowserRuntime has no manifest reference.',
  MANIFEST_NOT_FOUND: 'Referenced manifest could not be loaded.',
  INVALID_MANIFEST: 'Manifest failed validation.',
};

/**
 * @param {object} browserRuntime Persisted row: { id, state, manifestId }.
 * @param {object} [options]
 * @returns {Promise<{canLaunch:boolean, reason:string|null, manifest?:object, resolved?:object, errors?:Array}>}
 */
export async function canLaunch(browserRuntime, {
  manifestRoot = MANIFEST_ROOT_DEFAULT,
  goldenRoot = GOLDEN_ROOT_DEFAULT,
  allowedRunnerImages = DEFAULT_ALLOWED_RUNNER_IMAGES,
} = {}) {
  if (!browserRuntime || browserRuntime.state !== 'READY') {
    return { canLaunch: false, reason: 'NOT_READY' };
  }
  if (!browserRuntime.manifestId) {
    return { canLaunch: false, reason: 'NO_MANIFEST' };
  }

  const loaded = await loadManifest(browserRuntime.manifestId, { manifestRoot });
  if (loaded.error) {
    return {
      canLaunch: false,
      reason: 'MANIFEST_NOT_FOUND',
      manifestPath: loaded.manifestPath,
      errors: [loaded.error],
    };
  }

  const validation = await validateManifest(loaded.manifest, {
    runtimeId: browserRuntime.id,
    goldenRoot,
    allowedRunnerImages,
  });
  if (!validation.valid) {
    return {
      canLaunch: false,
      reason: 'INVALID_MANIFEST',
      manifestPath: loaded.manifestPath,
      manifest: loaded.manifest,
      errors: validation.errors,
    };
  }

  return {
    canLaunch: true,
    reason: null,
    manifestPath: loaded.manifestPath,
    manifest: loaded.manifest,
    resolved: validation.resolved,
  };
}
