/**
 * Browser-play session orchestration: the real READY -> Kasm session path.
 *
 * Responsibilities (in order):
 *   1. verify the Title's BrowserRuntime is READY and its manifest validates
 *   2. resolve the manifest's runner image against the live Kasm image list
 *   3. prepare/reuse the persistent per-user COW runtime (whole-tree clone)
 *   4. ensure the dedicated Kasm identity, set the per-launch attributes,
 *      reserve the one-active-per-user BrowserSession, and request the kasm
 *   5. reconcile/terminate the live Kasm session against the stored row
 *
 * This service never touches the archive, never mutates the golden, and never
 * exposes Kasm credentials. It is transport/DB orchestration only; the pure
 * path and manifest rules live in runtimeState.js / runtimeManifest.js.
 */

import {
  DEFAULT_ALLOWED_RUNNER_IMAGES,
  GOLDEN_ROOT_DEFAULT,
  MANIFEST_ROOT_DEFAULT,
} from './runtimeManifest.js';
import { USER_RUNTIME_ROOT_DEFAULT, ensureUserRuntime } from './runtimeState.js';
import { canLaunch } from './runtimeLaunch.js';
import {
  defaultLockRegistry,
  launchBrowserSession,
  prismaSessionStore,
} from './runtimeTarget.js';

/** App-visible session lifecycle states. */
export const SESSION_STATES = ['STARTING', 'RUNNING', 'STOPPING', 'ENDED', 'ERROR'];

/** Structured error carrying an HTTP status so routes stay thin. */
export class BrowserSessionError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'BrowserSessionError';
    this.code = code;
    this.status = status;
  }
}

const ok = (v) => typeof v === 'string' && v.length > 0;

/**
 * Map a live Kasm operational status onto our app lifecycle state.
 * Unknown / early values (requested, assigned, provisioning, pending) are
 * STARTING; anything unrecognised stays STARTING rather than guessing running.
 */
export function normalizeKasmStatus(raw) {
  const s = String(
    (raw && (raw.kasm?.operational_status ?? raw.operational_status ?? raw.status)) || '',
  ).toLowerCase();
  if (s === 'running') return 'RUNNING';
  if (['error', 'failed', 'crashed', 'failure'].includes(s)) return 'ERROR';
  if (['stopping', 'destroying', 'deleting'].includes(s)) return 'STOPPING';
  if (['stopped', 'destroyed', 'deleted', 'ended'].includes(s)) return 'ENDED';
  return 'STARTING';
}

/** Normalize the stored row for API output; never includes credentials/tokens. */
export function serializeBrowserSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    browserRuntimeId: row.browserRuntimeId,
    kasmSessionId: row.kasmSessionId ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    endedAt: row.endedAt ?? null,
  };
}

/** True when `user` may act on `row` (owner or admin). */
export function canManageSession(row, user) {
  if (!row || !user) return false;
  if (user.role === 'admin') return true;
  return row.userId === user.userId;
}

/** Extract the Kasm id from a request_kasm response (tolerant of shapes). */
export function extractKasmId(response) {
  if (!response || typeof response !== 'object') return null;
  return response.kasm_id ?? response.kasm?.kasm_id ?? response.kasmId ?? null;
}

/** Extract a connect URL from a join_kasm response (tolerant of shapes). */
export function extractConnectUrl(response, publicBaseUrl = null) {
  if (!response || typeof response !== 'object') return null;
  const url = response.kasm_url ?? response.url ?? response.connect_url ?? null;
  if (!ok(url)) return null;
  if (!publicBaseUrl) return url;
  try {
    const parsed = new URL(url);
    const base = new URL(publicBaseUrl);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Fetch the manifest declared runner image from the live Kasm image list. */
async function resolveRunnerImage(kasmClient, manifest) {
  const image = await kasmClient.findImage(manifest.runnerImage);
  if (!image) {
    throw new BrowserSessionError(
      'RUNNER_IMAGE_MISSING',
      409,
      `Runner image "${manifest.runnerImage}" is not available in Kasm.`,
    );
  }
  return image.image_id ?? image.id;
}

/**
 * Launch a browser session for a Title on behalf of one authenticated user.
 *
 * @returns {Promise<{session:object, runtime:object}>}
 */
export async function launchTitleBrowserSession({
  prisma,
  kasmClient,
  titleId,
  userId,
  goldenRoot = GOLDEN_ROOT_DEFAULT,
  manifestRoot = MANIFEST_ROOT_DEFAULT,
  userRuntimeRoot = USER_RUNTIME_ROOT_DEFAULT,
  allowedRunnerImages = DEFAULT_ALLOWED_RUNNER_IMAGES,
  lockRegistry = defaultLockRegistry,
  prepareRuntime = ensureUserRuntime,
  publicBaseUrl = null,
} = {}) {
  if (!kasmClient) {
    throw new BrowserSessionError('KASM_UNAVAILABLE', 503, 'Kasm client is not configured.');
  }

  const title = await prisma.title.findUnique({ where: { id: titleId }, select: { id: true, name: true } });
  if (!title) throw new BrowserSessionError('TITLE_NOT_FOUND', 404, `Title "${titleId}" not found.`);

  const runtime = await prisma.browserRuntime.findUnique({ where: { titleId } });
  if (!runtime) {
    throw new BrowserSessionError('NO_BROWSER_RUNTIME', 409, 'Title has no browser runtime.');
  }
  if (runtime.state !== 'READY') {
    throw new BrowserSessionError('RUNTIME_NOT_READY', 409, `Runtime state is ${runtime.state}, not READY.`);
  }

  const gate = await canLaunch(runtime, { manifestRoot, goldenRoot, allowedRunnerImages });
  if (!gate.canLaunch) {
    throw new BrowserSessionError('RUNTIME_NOT_LAUNCHABLE', 409, `Runtime is not launchable (${gate.reason}).`);
  }

  // One active session per user: bail before touching scratch so an in-flight
  // session for the same user is never disturbed.
  const active = await prisma.browserSession.findFirst({ where: { userId, activeKey: userId } });
  if (active) {
    throw new BrowserSessionError('ACTIVE_SESSION_EXISTS', 409, 'User already has an active browser session.');
  }

  const imageId = await resolveRunnerImage(kasmClient, gate.manifest);

  const prepared = await prepareRuntime({
    userRoot: userRuntimeRoot,
    goldenRoot,
    manifest: gate.manifest,
    userId,
    browserRuntimeId: runtime.id,
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, kasmUsername: true, kasmUserId: true },
  });

  let result;
  try {
    result = await launchBrowserSession({
      userId,
      browserRuntimeId: runtime.id,
      client: kasmClient,
      lockRegistry,
      store: prismaSessionStore(prisma),
      existingIdentity: { kasmUsername: user?.kasmUsername, kasmUserId: user?.kasmUserId },
      persistIdentity: (identity) =>
        prisma.user.update({
          where: { id: userId },
          data: { kasmUsername: identity.kasmUsername, kasmUserId: identity.kasmUserId },
        }),
      imageId,
    });
  } catch (err) {
    if (err?.code === 'ACTIVE_SESSION_EXISTS') {
      throw new BrowserSessionError('ACTIVE_SESSION_EXISTS', 409, err.message);
    }
    throw err;
  }

  return {
    session: serializeBrowserSession(result.session),
    runtime: {
      parentDir: prepared.parentDir,
      runtimeDir: prepared.runtimeDir,
      scratchDir: prepared.scratchDir,
      created: prepared.created,
    },
    kasmId: extractKasmId(result.request),
  };
}

/** Load a session row and enforce owner/admin access. */
export async function loadManagedSession({ prisma, sessionId, user }) {
  const row = await prisma.browserSession.findUnique({ where: { id: sessionId } });
  if (!row) throw new BrowserSessionError('SESSION_NOT_FOUND', 404, `Session "${sessionId}" not found.`);
  if (!canManageSession(row, user)) {
    throw new BrowserSessionError('FORBIDDEN', 403, 'You are not allowed to access this browser session.');
  }
  return row;
}

/**
 * Reconcile one session against live Kasm, returning the normalized app state.
 * Connect information is only produced once the kasm is RUNNING.
 */
export async function refreshBrowserSessionStatus({
  prisma,
  kasmClient,
  sessionId,
  user,
  publicBaseUrl = null,
} = {}) {
  let row = await loadManagedSession({ prisma, sessionId, user });
  const owner = await prisma.user.findUnique({ where: { id: row.userId }, select: { kasmUserId: true } });
  const kasmUserId = owner?.kasmUserId ?? null;
  let live = null;

  if (kasmClient && row.kasmSessionId && ['STARTING', 'RUNNING', 'STOPPING'].includes(row.state)) {
    try {
      live = await kasmClient.getSessionStatus(row.kasmSessionId, { userId: kasmUserId });
    } catch (err) {
      if (err?.status === 404) live = { status: 'destroyed' };
      else throw err;
    }
    const next = normalizeKasmStatus(live);
    if (next !== row.state) {
      row = await prisma.browserSession.update({
        where: { id: row.id },
        data: {
          state: next,
          lastSeenAt: new Date(),
          ...(['ENDED', 'ERROR'].includes(next) ? { activeKey: null, endedAt: new Date() } : {}),
        },
      });
    } else {
      row = await prisma.browserSession.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
    }
  }

  // get_kasm_status returns a ready-to-open `kasm_url`; fall back to join_kasm.
  let connectUrl = null;
  if (row.state === 'RUNNING' && kasmClient && row.kasmSessionId) {
    connectUrl = extractConnectUrl(live, publicBaseUrl);
    if (!connectUrl) {
      try {
        connectUrl = extractConnectUrl(await kasmClient.joinSession(row.kasmSessionId, { userId: kasmUserId }), publicBaseUrl);
      } catch {
        connectUrl = null;
      }
    }
  }

  return { session: serializeBrowserSession(row), connectUrl };
}

/**
 * Stop + destroy the live Kasm session and end the row. The persistent COW
 * runtime is retained; only scratch is reset.
 */
export async function terminateBrowserSession({
  prisma,
  kasmClient,
  sessionId,
  user,
  userRuntimeRoot = USER_RUNTIME_ROOT_DEFAULT,
  resetScratch = true,
} = {}) {
  const row = await loadManagedSession({ prisma, sessionId, user });

  if (['ENDED', 'ERROR'].includes(row.state)) {
    return { session: serializeBrowserSession(row), stopped: false };
  }

  const owner = await prisma.user.findUnique({ where: { id: row.userId }, select: { kasmUserId: true } });
  const kasmUserId = owner?.kasmUserId ?? null;
  if (kasmClient && row.kasmSessionId) {
    await kasmClient.stopSession(row.kasmSessionId, { userId: kasmUserId }).catch(() => {});
    await kasmClient.destroySession(row.kasmSessionId, { userId: kasmUserId }).catch(() => {});
  }

  const ended = await prisma.browserSession.update({
    where: { id: row.id },
    data: { state: 'ENDED', activeKey: null, endedAt: new Date(), lastSeenAt: new Date() },
  });

  if (resetScratch) {
    try {
      const { sessionScratchDir } = await import('./runtimeState.js');
      const scratch = sessionScratchDir(userRuntimeRoot, ended.userId, ended.browserRuntimeId);
      const { rm, mkdir } = await import('node:fs/promises');
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true });
    } catch {
      // Scratch reset is best-effort; the persistent runtime is what matters.
    }
  }

  return { session: serializeBrowserSession(ended), stopped: true };
}
