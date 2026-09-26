/**
 * Race-safe launch-target selection for Kasm browser sessions.
 *
 * WHY THIS EXISTS
 * ---------------
 * Kasm expands image `volume_mappings` variables through
 * `ProviderManager.get_container` (provider_manager, line ~488) using the Kasm
 * user's `custom_attribute_1/2/3` columns at the moment it runs. The manager's
 * guardian loop (manager_api_server, line ~183) calls `get_container` again for
 * any kasm still in ASSIGNED/REQUESTED, re-reading the user's CURRENT
 * attributes. So a single shared Kasm user is unsafe: a concurrent launch by
 * another app user overwrites the attributes and the first session can be
 * re-expanded onto the wrong `/srv/vn-runtime/users/<id>/<id>` tree.
 *
 * THE FIX
 * -------
 * 1. One dedicated Kasm user per app user (`vnoctis-<appUserId>`), created
 *    lazily. `custom_attribute_1` (app user UUID) is therefore stable and
 *    independent per app user; different users never share attributes.
 * 2. `custom_attribute_2` (runtime UUID) is the only value set per launch.
 * 3. At most one active BrowserSession per app user (DB `activeKey = userId`),
 *    so `custom_attribute_2` cannot change while a kasm is still in
 *    ASSIGNED/REQUESTED. Same-user multi-runtime concurrency is intentionally
 *    NOT supported by this prototype.
 * 4. A per-user application mutex makes `setRuntimeTarget -> requestSession`
 *    atomic so two app-side calls cannot interleave the two Kasm API calls.
 *
 * Callers must use `launchBrowserSession`; never call `setRuntimeTarget` and
 * `requestSession` independently.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Error with a stable machine code. */
export class LaunchTargetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LaunchTargetError';
    this.code = code;
  }
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Deterministic, path/Kasm-safe username for one app user. */
export function deriveKasmUsername(appUserId) {
  if (!isUuid(appUserId)) {
    throw new LaunchTargetError('INVALID_USER_ID', 'appUserId must be a UUID.');
  }
  return `vnoctis-${appUserId}`;
}

/**
 * Tiny promise-chain mutex registry. `run(key, fn)` serializes `fn` per key and
 * lets different keys proceed in parallel.
 */
export function createLockRegistry() {
  const tails = new Map();
  return {
    run(key, fn) {
      const prev = tails.get(key) ?? Promise.resolve();
      const result = prev.then(() => fn());
      // Keep a settled tail so one rejection cannot poison the chain.
      tails.set(key, result.then(() => {}, () => {}));
      return result;
    },
  };
}

const defaultLockRegistry = createLockRegistry();

/**
 * Resolve (find or create) the dedicated Kasm user for one app user.
 *
 * @param {object} options
 * @param {string} options.appUserId
 * @param {object} options.client      Kasm client (createUser/findUserByUsername).
 * @param {object} [options.existing]  { kasmUsername, kasmUserId } from the DB row.
 */
export async function ensureKasmIdentity({ appUserId, client, existing = {} } = {}) {
  const username = existing.kasmUsername || deriveKasmUsername(appUserId);
  if (existing.kasmUserId) {
    return { kasmUsername: username, kasmUserId: existing.kasmUserId, created: false };
  }

  const found = await client.findUserByUsername(username);
  if (found) {
    const id = found.user_id ?? found.id;
    if (!id) throw new LaunchTargetError('KASM_IDENTITY_UNRESOLVED', 'Kasm user lookup returned no id.');
    return { kasmUsername: username, kasmUserId: id, created: false };
  }

  const createdUser = await client.createUser({ username });
  const id = createdUser?.user_id ?? createdUser?.id;
  if (!id) throw new LaunchTargetError('KASM_IDENTITY_UNRESOLVED', 'Kasm user creation returned no id.');
  return { kasmUsername: username, kasmUserId: id, created: true };
}

/**
 * Prisma-backed BrowserSession store. `activeKey = userId` enforces at most one
 * active session per app user at the database level.
 */
export function prismaSessionStore(prisma) {
  return {
    async reserve({ browserRuntimeId, userId }) {
      try {
        return await prisma.browserSession.create({
          data: { browserRuntimeId, userId, activeKey: userId, state: 'STARTING' },
        });
      } catch (err) {
        if (err && err.code === 'P2002') {
          throw new LaunchTargetError('ACTIVE_SESSION_EXISTS', 'User already has an active browser session.');
        }
        throw err;
      }
    },
    async markStarted(id, kasmSessionId) {
      return prisma.browserSession.update({
        where: { id },
        data: { kasmSessionId, state: 'RUNNING', lastSeenAt: new Date() },
      });
    },
    async markFailed(id) {
      return prisma.browserSession.update({
        where: { id },
        data: { state: 'ERROR', activeKey: null, endedAt: new Date() },
      });
    },
    async getById(id) {
      return prisma.browserSession.findUnique({ where: { id } });
    },
    async findActiveByUser(userId) {
      return prisma.browserSession.findFirst({ where: { userId, activeKey: userId } });
    },
    /** Reconcile a live Kasm status onto the row; terminal states clear activeKey. */
    async updateState(id, state) {
      const terminal = state === 'ENDED' || state === 'ERROR';
      return prisma.browserSession.update({
        where: { id },
        data: {
          state,
          lastSeenAt: new Date(),
          ...(terminal ? { activeKey: null, endedAt: new Date() } : {}),
        },
      });
    },
  };
}

/**
 * Atomically select the launch target and request one Kasm session.
 *
 * Order: lock(user) -> ensure identity -> reserve BrowserSession ->
 * setRuntimeTarget -> requestSession -> mark started. On failure the reserved
 * session is marked ERROR and its activeKey cleared.
 *
 * @returns {Promise<{kasmUsername, kasmUserId, session, request}>}
 */
export async function launchBrowserSession({
  userId,
  browserRuntimeId,
  client,
  lockRegistry = defaultLockRegistry,
  store = null,
  existingIdentity = {},
  persistIdentity = null,
  launchSelections = {},
  imageId = null,
} = {}) {
  if (!isUuid(userId)) throw new LaunchTargetError('INVALID_USER_ID', 'userId must be a UUID.');
  if (!isUuid(browserRuntimeId)) {
    throw new LaunchTargetError('INVALID_RUNTIME_ID', 'browserRuntimeId must be a UUID.');
  }
  if (!client) throw new LaunchTargetError('NO_KASM_CLIENT', 'A Kasm client is required.');

  return lockRegistry.run(userId, async () => {
    const identity = await ensureKasmIdentity({ appUserId: userId, client, existing: existingIdentity });
    if (typeof persistIdentity === 'function' && identity.kasmUserId !== existingIdentity.kasmUserId) {
      await persistIdentity(identity);
    }

    const session = store ? await store.reserve({ browserRuntimeId, userId }) : null;
    try {
      await client.setRuntimeTarget({
        kasmUserId: identity.kasmUserId,
        kasmUsername: identity.kasmUsername,
        appUserId: userId,
        browserRuntimeId,
      });
      const request = await client.requestSession({
        userId: identity.kasmUserId,
        launchSelections,
        imageId,
      });
      const kasmSessionId = request?.kasm_id ?? request?.kasm?.kasm_id ?? null;
      const started = store && session
        ? await store.markStarted(session.id, kasmSessionId)
        : session;
      return { kasmUsername: identity.kasmUsername, kasmUserId: identity.kasmUserId, session: started, request };
    } catch (err) {
      if (store && session) {
        await store.markFailed(session.id).catch(() => {});
      }
      throw err;
    }
  });
}

export { defaultLockRegistry };
