/**
 * Browser-runtime workflow domain logic (state/workflow only).
 *
 * This module is deliberately pure: it validates states and transitions and
 * shapes the read DTO. It performs no database writes, no Docker/Kasm calls,
 * and touches no filesystem.
 *
 * Ownership decision: a Title may eventually have several ArchiveItem releases,
 * but only one prepared release becomes browser-playable, and a Title can be
 * REQUESTED before any release is chosen. Game stays the legacy web-build
 * compatibility layer, so browser-runtime state lives on its own
 * `BrowserRuntime` row (one per Title) plus per-user `WebRequest` rows.
 * `ARCHIVE_ONLY` is represented by the absence of a BrowserRuntime row, but is
 * always exposed explicitly by the API.
 */

/** Every state the API can expose, including the derived absence state. */
export const RUNTIME_STATES = [
  'ARCHIVE_ONLY',
  'REQUESTED',
  'PREPARING',
  'TESTING',
  'READY',
  'BROKEN',
  'UNSUPPORTED',
];

/** States that are actually persisted on a BrowserRuntime row. */
export const STORED_RUNTIME_STATES = RUNTIME_STATES.filter((state) => state !== 'ARCHIVE_ONLY');

/**
 * Allowed state transitions.
 *
 * Normal path: ARCHIVE_ONLY -> REQUESTED -> PREPARING -> TESTING -> READY.
 * Admin exceptions: REQUESTED -> UNSUPPORTED; PREPARING/TESTING -> BROKEN;
 * BROKEN -> PREPARING; UNSUPPORTED -> REQUESTED/PREPARING (explicit reopen).
 * ARCHIVE_ONLY may start directly at REQUESTED or PREPARING. READY is terminal
 * for this prototype. A same-state transition is always a valid no-op.
 */
export const ALLOWED_TRANSITIONS = {
  ARCHIVE_ONLY: ['REQUESTED', 'PREPARING'],
  REQUESTED: ['PREPARING', 'UNSUPPORTED'],
  PREPARING: ['TESTING', 'BROKEN'],
  TESTING: ['READY', 'BROKEN'],
  READY: [],
  BROKEN: ['PREPARING'],
  UNSUPPORTED: ['REQUESTED', 'PREPARING'],
};

/** Normalize an absent runtime to the derived ARCHIVE_ONLY state. */
export function normalizeRuntimeState(state) {
  return state || 'ARCHIVE_ONLY';
}

/** True when `state` is one of the persisted BrowserRuntime states. */
export function isStoredRuntimeState(state) {
  return STORED_RUNTIME_STATES.includes(state);
}

/** True when `from` may transition to `to` (same state is a valid no-op). */
export function canTransition(from, to) {
  const current = normalizeRuntimeState(from);
  if (current === to) return true;
  return (ALLOWED_TRANSITIONS[current] ?? []).includes(to);
}

/** Allowed next states from `from`. */
export function nextRuntimeStates(from) {
  return ALLOWED_TRANSITIONS[normalizeRuntimeState(from)] ?? [];
}

/**
 * Serialize the browser-runtime read block for a Title.
 *
 * `requestedByCurrentUser` is scoped to the caller, so ordinary users never see
 * other users' identities — only a request count. Title with no runtime row and
 * no request is ARCHIVE_ONLY.
 */
export function serializeBrowserRuntime(runtime, webRequests = [], currentUserId = null) {
  const requests = Array.isArray(webRequests) ? webRequests : [];
  return {
    state: normalizeRuntimeState(runtime?.state),
    archiveItemId: runtime?.archiveItemId ?? null,
    note: runtime?.note ?? null,
    createdAt: runtime?.createdAt ?? null,
    updatedAt: runtime?.updatedAt ?? null,
    requestCount: requests.length,
    requestedByCurrentUser: !!currentUserId && requests.some((r) => r.userId === currentUserId),
  };
}
