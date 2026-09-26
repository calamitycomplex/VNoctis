/**
 * Server-only Kasm 1.19 Developer API client.
 *
 * The browser never talks to Kasm directly: vnm-api holds the Kasm credentials
 * and returns only what a session needs. This module is transport-only — it does
 * not read the database, touch the filesystem, or enqueue work.
 *
 * AUTH (verified live on Holo against Kasm 1.19)
 * ----------------------------------------------
 * The Developer API is served at `/api/public/...`. Credentials are supplied in
 * the JSON request BODY, not headers:
 *
 *   { "api_key": "<key>", "api_key_secret": "<secret>", ...operation fields }
 *
 * `POST https://holo/api/public/get_users` with just those two body fields
 * returned HTTP 200. `/api/*` (the ClientApi tree) and `/api/admin/*` are NOT
 * the Developer API surface this client uses.
 *
 * SECRETS
 * -------
 * The key/secret live only in environment variables. They are placed in the
 * request body and are never logged, stored, returned, or echoed into error
 * messages. Log lines carry only the Kasm path/status.
 *
 * TLS
 * ---
 * Kasm serves a self-signed certificate (CN=holo on Holo). Rather than disabling
 * verification, pass the Kasm nginx certificate via `caPath`; it is supplied as
 * an explicit CA while normal hostname verification stays ON. Reach Kasm by a
 * name matching that certificate (`https://holo` via extra_hosts host-gateway).
 */

import { readFileSync } from 'node:fs';
import https from 'node:https';

/** Developer API prefix. */
export const PUBLIC_API_PREFIX = '/api/public';

/** Build TLS options; never disables verification. */
export function buildTlsOptions(caPath) {
  if (!caPath) return {};
  return { ca: [readFileSync(caPath)] };
}

/**
 * Default HTTPS transport. Exposes `ca` when a CA path is configured and keeps
 * `rejectUnauthorized` at its secure default (true). Never sets
 * rejectUnauthorized=false.
 */
export function createHttpsTransport({ caPath } = {}) {
  return ({ method = 'POST', url, headers = {}, body }) =>
    new Promise((resolve, reject) => {
      // Read the CA per request so a cert mounted after startup is picked up,
      // and a missing file fails the request instead of the whole process.
      let tls = {};
      try {
        tls = buildTlsOptions(caPath);
      } catch (err) {
        reject(new Error(`Cannot read Kasm CA at ${caPath}: ${err.message}`));
        return;
      }
      const target = new URL(url);
      const req = https.request(
        {
          method,
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          headers,
          ...tls,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(data); } catch { /* non-JSON error page */ }
            resolve({ status: res.statusCode, json, raw: data });
          });
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
}

/**
 * Kasm image ids are serialized by the API in undelimited hex form
 * (e.g. `caaa88a241f04ea39f864d8773d2031b`), while configs often carry the
 * dashed UUID. Normalize to the API's canonical form.
 */
export function normalizeImageId(imageId) {
  return typeof imageId === 'string' ? imageId.replace(/-/g, '') : imageId;
}

/**
 * Create a Kasm Developer API client.
 *
 * @param {object} options
 * @param {string} options.baseUrl       e.g. https://holo
 * @param {string} [options.apiKey]
 * @param {string} [options.apiKeySecret]
 * @param {string} [options.imageId]     Default Kasm image id for sessions.
 * @param {string} [options.caPath]      Kasm nginx certificate for explicit trust.
 * @param {Function} [options.transport] Injectable transport (tests).
 * @param {object} [options.logger]      Optional pino-style logger (never sees secrets).
 */
export function createKasmClient({
  baseUrl,
  apiKey,
  apiKeySecret,
  imageId,
  caPath,
  transport,
  logger,
} = {}) {
  if (!baseUrl) throw new Error('Kasm client requires KASM_BASE_URL.');
  const base = baseUrl.replace(/\/+$/, '');
  const send = transport ?? createHttpsTransport({ caPath });

  /** Auth fields merged into every request body. */
  function auth() {
    const a = {};
    if (apiKey) {
      a.api_key = apiKey;
      a.api_key_secret = apiKeySecret ?? '';
    }
    return a;
  }

  /**
   * Single request helper. Auth + body handling live here only, so no method
   * duplicates credential wiring. Never puts secrets in logs or errors.
   */
  async function request(path, payload = {}) {
    const url = `${base}${path}`;
    const body = { ...auth(), ...payload };
    logger?.debug?.({ kasmPath: path }, 'kasm api call');
    let res;
    try {
      // Content-Type only — credentials travel in the JSON body.
      res = await send({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body });
    } catch (err) {
      const e = new Error(`Kasm API request to ${path} failed: ${err.message}`);
      e.code = 'KASM_TRANSPORT_ERROR';
      throw e;
    }
    if (res.status >= 400) {
      const message = res.json?.error_message || res.json?.message || `Kasm API ${path} returned ${res.status}.`;
      const e = new Error(message);
      e.code = 'KASM_API_ERROR';
      e.status = res.status;
      e.body = res.json ?? res.raw ?? null;
      logger?.warn?.({ kasmPath: path, status: res.status, message }, 'kasm api error');
      throw e;
    }
    return res.json;
  }

  const p = (name) => `${PUBLIC_API_PREFIX}/${name}`;

  return {
    /** Configured default image id (non-secret, normalized to API form). */
    imageId: normalizeImageId(imageId),
    /** Whether credentials are configured (non-secret). */
    hasCredentials: Boolean(apiKey && apiKeySecret),
    /** Whether an explicit CA was configured. */
    hasCa: Boolean(caPath),
    /** Developer API prefix in use. */
    apiPrefix: PUBLIC_API_PREFIX,

    // ── Images ─────────────────────────────────────────────────────────────
    /** List images. Response: `{ images: [...] }`. */
    getImages({ page = 1, pageSize = null } = {}) {
      const payload = {};
      if (page != null) payload.page = page;
      if (pageSize != null) payload.page_size = pageSize;
      return request(p(`get_images`), payload);
    },

    /** Find one image by id (dashed or hex), matching `image_id`/`name`. */
    async findImage(imageIdOrName) {
      const res = await request(p(`get_images`), {});
      const images = res?.images ?? [];
      const target = normalizeImageId(imageIdOrName);
      return images.find((i) => normalizeImageId(i?.image_id) === target || i?.name === imageIdOrName || i?.friendly_name === imageIdOrName) ?? null;
    },

    // ── Users ──────────────────────────────────────────────────────────────
    /**
     * List/paginate users. Response: `{ users, total, ... }`.
     *
     * LIVE NOTE (Kasm 1.19): sending `page` AND `page_size` together makes
     * `get_users` return an empty object; each works alone. We therefore omit
     * `page` unless the caller passes one explicitly. The server-side
     * `filters` field returns HTTP 500 in this version, so callers filter
     * locally instead of relying on it.
     */
    async getUsers({ page = null, pageSize = 100, filters = null, sortBy = 'username', sortDirection = 'asc' } = {}) {
      const payload = {};
      if (page != null) payload.page = page;
      if (pageSize != null) payload.page_size = pageSize;
      if (sortBy) payload.sort_by = sortBy;
      if (sortDirection) payload.sort_direction = sortDirection;
      if (filters) payload.filters = filters;
      const res = await request(p(`get_users`), payload);
      const users = res?.users ?? res?.user ?? (Array.isArray(res) ? res : []);
      return { ...(res ?? {}), users };
    },

    /** Find one user by exact username, or null (filtered locally). */
    async findUserByUsername(username) {
      const res = await this.getUsers({ pageSize: 250 });
      const users = res?.users ?? [];
      return users.find((u) => u?.username === username) ?? null;
    },

    /** Create a dedicated Kasm user. Custom attributes are set separately. */
    createUser({ username, password = null, ...extra } = {}) {
      const payload = { username, ...extra };
      if (password) payload.password = password;
      return request(p(`create_user`), payload);
    },

    /**
     * Set arbitrary attributes on a Kasm user (e.g. custom_attribute_1/2).
     * Body: `{ user_id, target_user_attributes: {...} }`.
     */
    updateUserAttributes({ userId, attributes }) {
      return request(p(`update_user_attributes`), {
        user_id: userId,
        target_user_attributes: attributes,
      });
    },

    /**
     * Point a Kasm user's mount template at one app user + runtime pair.
     * custom_attribute_1 = application user id, custom_attribute_2 = runtime id.
     *
     * Do NOT call this and `requestSession` independently from route code —
     * use services/runtimeTarget.js `launchBrowserSession`, which sequences the
     * two calls under a per-user lock so concurrent launches cannot race.
     */
    setRuntimeTarget({ kasmUserId, appUserId, browserRuntimeId }) {
      return this.updateUserAttributes({
        userId: kasmUserId,
        attributes: { custom_attribute_1: appUserId, custom_attribute_2: browserRuntimeId },
      });
    },

    // ── Sessions ───────────────────────────────────────────────────────────
    /**
     * Request a new session. `userId` impersonates a specific Kasm user so the
     * session is owned by that user (required for per-user mounts + lifecycle).
     */
    requestSession({ userId = null, launchSelections = {}, imageId: overrideImage, ...extra } = {}) {
      const payload = { image_id: normalizeImageId(overrideImage || imageId) };
      if (userId) payload.user_id = userId;
      if (launchSelections && Object.keys(launchSelections).length > 0) {
        payload.launch_selections = launchSelections;
      }
      for (const [k, v] of Object.entries(extra)) payload[k] = v;
      return request(p(`request_kasm`), payload);
    },

    getSessionStatus(kasmId) {
      return request(p(`get_kasm_status`), { kasm_id: kasmId });
    },

    joinSession(kasmId) {
      return request(p(`join_kasm`), { kasm_id: kasmId });
    },

    stopSession(kasmId) {
      return request(p(`stop_kasm`), { kasm_id: kasmId });
    },

    destroySession(kasmId, { deletePending = false } = {}) {
      const payload = { kasm_id: kasmId };
      if (deletePending) payload.delete_pending = true;
      return request(p(`destroy_kasm`), payload);
    },

    /**
     * Recent kasms for the authenticated user.
     *
     * LIVE NOTE (Kasm 1.19): `get_recent_kasms` returns a literal JSON
     * `null` when there are no sessions, so normalize to `{ kasms: [...] }`.
     */
    async getRecentKasms({ page = null, pageSize = 100 } = {}) {
      const payload = {};
      if (page != null) payload.page = page;
      if (pageSize != null) payload.page_size = pageSize;
      const res = await request(p(`get_recent_kasms`), payload);
      return { ...(res ?? {}), kasms: res?.kasms ?? [] };
    },
  };
}
