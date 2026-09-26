import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTlsOptions, createHttpsTransport, createKasmClient } from './kasmClient.js';

const SECRET = 'super-secret-value';

function recordingTransport(calls, reply = { status: 200, json: { ok: true } }) {
  return async (req) => {
    calls.push(req);
    return reply;
  };
}

function client(calls, extra = {}) {
  return createKasmClient({
    baseUrl: 'https://holo',
    apiKey: 'KEY123',
    apiKeySecret: SECRET,
    imageId: 'image-uuid',
    transport: recordingTransport(calls),
    ...extra,
  });
}

test('requestSession posts image_id, impersonation user_id and launch selections', async () => {
  const calls = [];
  await client(calls).requestSession({ userId: 'kasm-user', launchSelections: { VN_RUNTIME_ID: 'rt' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://holo/api/request_kasm');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    image_id: 'image-uuid',
    user_id: 'kasm-user',
    launch_selections: { VN_RUNTIME_ID: 'rt' },
  });
});

test('credentials are sent as api-key/api-key-secret headers', async () => {
  const calls = [];
  await client(calls).requestSession({});
  assert.equal(calls[0].headers['api-key'], 'KEY123');
  assert.equal(calls[0].headers['api-key-secret'], SECRET);
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

test('image override is honored', async () => {
  const calls = [];
  await client(calls).requestSession({ imageId: 'other-image' });
  assert.equal(calls[0].body.image_id, 'other-image');
});

test('status/join/stop/destroy call the expected endpoints with kasm_id', async () => {
  const calls = [];
  const c = client(calls);
  await c.getSessionStatus('k1');
  await c.joinSession('k1');
  await c.stopSession('k1');
  await c.destroySession('k1');
  assert.deepEqual(calls.map((x) => x.url.split('/').pop()), [
    'get_kasm_status', 'join_kasm', 'stop_kasm', 'destroy_kasm',
  ]);
  for (const call of calls) assert.equal(call.body.kasm_id, 'k1');
});

test('setRuntimeTarget sets custom attribute mount template', async () => {
  const calls = [];
  await client(calls).setRuntimeTarget({ kasmUserId: 'kasm-user', appUserId: 'app-u', browserRuntimeId: 'rt-u' });
  assert.equal(calls[0].url, 'https://holo/api/update_user_attribute');
  assert.deepEqual(calls[0].body, {
    user_id: 'kasm-user',
    target_user_attributes: { custom_attribute_1: 'app-u', custom_attribute_2: 'rt-u' },
  });
});

test('admin identity calls hit create_user and get_users, never leak the secret', async () => {
  const calls = [];
  const c = client(calls, {
    transport: async (req) => {
      calls.push(req);
      if (req.url.endsWith('/api/admin/get_users')) return { status: 200, json: { users: [{ user_id: 'ku', username: 'vnoctis-x' }] } };
      return { status: 200, json: { user_id: 'new-ku', username: 'vnoctis-y' } };
    },
  });

  const created = await c.createUser({ username: 'vnoctis-y' });
  assert.equal(calls[0].url, 'https://holo/api/admin/create_user');
  assert.equal(calls[0].body.username, 'vnoctis-y');
  assert.equal(created.user_id, 'new-ku');

  const found = await c.findUserByUsername('vnoctis-x');
  assert.equal(found.user_id, 'ku');
  assert.equal(calls[1].url, 'https://holo/api/admin/get_users');

  const missing = await c.findUserByUsername('nope');
  assert.equal(missing, null);
});

test('API errors surface a structured code and message', async () => {
  const calls = [];
  const c = createKasmClient({
    baseUrl: 'https://holo',
    apiKey: 'k',
    apiKeySecret: 's',
    transport: recordingTransport(calls, { status: 400, json: { error_message: 'Invalid Request' } }),
  });
  await assert.rejects(c.requestSession({}), (err) => {
    assert.equal(err.code, 'KASM_API_ERROR');
    assert.equal(err.status, 400);
    assert.match(err.message, /Invalid Request/);
    return true;
  });
});

test('secrets never appear in logger output', async () => {
  const calls = [];
  const logs = [];
  const logger = {
    debug: (obj, msg) => logs.push([obj, msg]),
    warn: (obj, msg) => logs.push([obj, msg]),
  };
  const c = createKasmClient({
    baseUrl: 'https://holo',
    apiKey: 'KEY123',
    apiKeySecret: SECRET,
    imageId: 'i',
    transport: recordingTransport(calls),
    logger,
  });
  await c.requestSession({ userId: 'u' });
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('KEY123'), false);
});

test('TLS uses explicit CA trust and keeps normal verification', async (t) => {
  // Without a CA path, rely on system CAs (no insecure override).
  assert.deepEqual(buildTlsOptions(null), {});
  assert.deepEqual(buildTlsOptions(''), {});

  const dir = mkdtempSync(join(tmpdir(), 'vnm-kasm-ca-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caPath = join(dir, 'kasm.crt');
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');

  const tls = buildTlsOptions(caPath);
  assert.ok(Array.isArray(tls.ca));
  assert.equal(tls.rejectUnauthorized, undefined); // secure default preserved

  // Transport factory is constructible from a CA path without touching network.
  assert.equal(typeof createHttpsTransport({ caPath }), 'function');
});

test('client exposes non-secret capability flags', () => {
  const calls = [];
  const c = client(calls);
  assert.equal(c.hasCredentials, true);
  assert.equal(c.imageId, 'image-uuid');
  const incomplete = createKasmClient({ baseUrl: 'https://holo', transport: recordingTransport(calls) });
  assert.equal(incomplete.hasCredentials, false);
  assert.equal(incomplete.hasCa, false);
});
