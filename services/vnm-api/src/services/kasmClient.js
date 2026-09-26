/**
 * Server-only Kasm 1.19 REST client.
 *
 * The browser never talks to Kasm directly: vnm-api holds the Kasm credentials
 * and returns a ready-to-open session URL. This module is transport-only — it
 * does not read the database, touch the filesystem, or enqueue work.
 *
 * Auth: a Kasm Developer API key sent as the `api-key` / `api-key-secret`
 * headers. Secrets live only in environment variables and are never logged,
 * stored in the DB, or returned to clients.
 *
 * TLS: Kasm serves a self-signed certificate (CN=holo on Holo). Instead of
 * disabling verification, pass the Kasm nginx certificate via `caPath`; it is
 * read and supplied as an explicit CA while normal hostname verification stays
 * ON. The app should reach Kasm by a name matching that certificate (e.g.
 * `https://holo` via an extra_hosts host-gateway entry).
 */

import { readFileSync } from 'node:fs';
import https from 'node:https';

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
 * Create a Kasm client.
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

  /** Request headers. The secret is included here only, never logged. */
  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) {
      h['api-key'] = apiKey;
      h['api-key-secret'] = apiKeySecret ?? '';
    }
    return h;
  }

  async function call(path, body) {
    const url = `${base}${path}`;
    logger?.debug?.({ kasmPath: path }, 'kasm api call');
    let res;
    try {
      res = await send({ method: 'POST', url, headers: headers(), body });
    } catch (err) {
      // Transport errors never contain request headers; rethrow with context.
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

  return {
    /** Configured default image id (non-secret). */
    imageId,
    /** Transport factory echoed for diagnostics (no secrets). */
    hasCredentials: Boolean(apiKey && apiKeySecret),
    /** Whether an explicit CA was configured. */
    hasCa: Boolean(caPath),

    /**
     * Request a new session. `userId` impersonates a specific Kasm user so the
     * session is owned by that user (required for per-user mounts + lifecycle).
     */
    requestSession({ userId = null, launchSelections = {}, imageId: overrideImage } = {}) {
      const body = { image_id: overrideImage || imageId };
      if (userId) body.user_id = userId;
      if (launchSelections && Object.keys(launchSelections).length > 0) {
        body.launch_selections = launchSelections;
      }
      return call('/api/request_kasm', body);
    },

    getSessionStatus(kasmId) {
      return call('/api/get_kasm_status', { kasm_id: kasmId });
    },

    joinSession(kasmId) {
      return call('/api/join_kasm', { kasm_id: kasmId });
    },

    stopSession(kasmId) {
      return call('/api/stop_kasm', { kasm_id: kasmId });
    },

    destroySession(kasmId) {
      return call('/api/destroy_kasm', { kasm_id: kasmId });
    },

    /**
     * Set per-launch target attributes on a Kasm user. Used to point the image
     * volume template at exactly one user/runtime tree.
     *
     * Do NOT call this and `requestSession` independently from route code —
     * use services/runtimeTarget.js `launchBrowserSession`, which sequences the
     * two calls under a per-user lock so concurrent launches cannot race.
     */
    updateUserAttributes({ userId, attributes }) {
      return call('/api/update_user_attribute', {
        user_id: userId,
        target_user_attributes: attributes,
      });
    },

    /**
     * Point a Kasm user's mount template at one app user + runtime pair.
     * custom_attribute_1 = application user id, custom_attribute_2 = runtime id.
     */
    setRuntimeTarget({ kasmUserId, appUserId, browserRuntimeId }) {
      return call('/api/update_user_attribute', {
        user_id: kasmUserId,
        target_user_attributes: {
          custom_attribute_1: appUserId,
          custom_attribute_2: browserRuntimeId,
        },
      });
    },

    // ── Admin: per-app-user Kasm identity ─────────────────────────────────
    // These use the Admin API (/api/admin/*); the configured Kasm credential
    // must belong to an admin. They create/lookup the dedicated Kasm user whose
    // custom attributes stay stable for the app user.

    /** Create a dedicated Kasm user for an app user. */
    createUser({ username, password = null, attributes = {} } = {}) {
      const body = { username };
      if (password) body.password = password;
      // `disabled: false` keeps the identity usable; no secret is stored here.
      for (const [key, value] of Object.entries(attributes)) body[key] = value;
      return call('/api/admin/create_user', body);
    },

    /** List Kasm users (Admin API). */
    getUsers() {
      return call('/api/admin/get_users', {});
    },

    /** Find one Kasm user by exact username, or null. */
    async findUserByUsername(username) {
      const res = await call('/api/admin/get_users', {});
      const users = res?.users ?? res?.user ?? (Array.isArray(res) ? res : []);
      return users.find((u) => u?.username === username) ?? null;
    },
  };
}
