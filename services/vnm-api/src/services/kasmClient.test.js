/**
 * Kasm 1.19 Developer API client contract tests.
 *
 * These assert the live-verified transport semantics: credentials travel in the
 * JSON body, the `/api/public/...` tree is used, and no secret leaks into
 * headers, logs, errors, or returned objects. No live Kasm call is made.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PUBLIC_API_PREFIX,
  buildTlsOptions,
  createHttpsTransport,
  createKasmClient,
  normalizeImageId,
} from './kasmClient.js';

const SECRET = 'super-secret-value';
const IMAGE_DASHED = 'caaa88a2-41f0-4ea3-9f86-4d8773d2031b';
const IMAGE_HEX = 'caaa88a241f04ea39f864d8773d2031b';

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
    imageId: IMAGE_DASHED,
    transport: recordingTransport(calls),
    ...extra,
  });
}

test('credentials go in the JSON body, not headers', async () => {
  const calls = [];
  await client(calls).getSessionStatus('k1');
  assert.equal(calls[0].body.api_key, 'KEY123');
  assert.equal(calls[0].body.api_key_secret, SECRET);
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json' });
  assert.equal(calls[0].headers['api-key'], undefined);
  assert.equal(calls[0].headers['api-key-secret'], undefined);
});

test('every operation uses the /api/public Developer API tree', async () => {
  const calls = [];
  const c = client(calls);
  await c.getImages();
  await c.getUsers();
  await c.createUser({ username: 'u' });
  await c.updateUserAttributes({ userId: 'ku', attributes: { custom_attribute_1: 'a' } });
  await c.requestSession({ userId: 'ku' });
  await c.getSessionStatus('k');
  await c.joinSession('k');
  await c.stopSession('k');
  await c.destroySession('k');
  await c.getRecentKasms();
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://holo/api/public/'), call.url);
  }
  assert.equal(c.apiPrefix, PUBLIC_API_PREFIX);
});

test('requestSession sends body fields and normalizes the image id', async () => {
  const calls = [];
  await client(calls).requestSession({ userId: 'kasm-user', launchSelections: { VN_RUNTIME_ID: 'rt' } });
  assert.equal(calls[0].url, 'https://holo/api/public/request_kasm');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    api_key: 'KEY123',
    api_key_secret: SECRET,
    image_id: IMAGE_HEX,
    user_id: 'kasm-user',
    launch_selections: { VN_RUNTIME_ID: 'rt' },
  });
});

test('image override is honored and normalized', async () => {
  const calls = [];
  await client(calls).requestSession({ imageId: '11111111-2222-3333-4444-555555555555' });
  assert.equal(calls[0].body.image_id, '11111111222233334444555555555555');
});

test('status/join/stop/destroy call the expected public endpoints with kasm_id', async () => {
  const calls = [];
  const c = client(calls);
  await c.getSessionStatus('k1');
  await c.joinSession('k1');
  await c.stopSession('k1');
  await c.destroySession('k1', { deletePending: true });
  assert.deepEqual(calls.map((x) => x.url.split('/').pop()), [
    'get_kasm_status', 'join_kasm', 'stop_kasm', 'destroy_kasm',
  ]);
  for (const call of calls) assert.equal(call.body.kasm_id, 'k1');
  assert.equal(calls[3].body.delete_pending, true);
});

test('update custom attributes uses user_id + target_user_attributes', async () => {
  const calls = [];
  await client(calls).setRuntimeTarget({ kasmUserId: 'kasm-user', appUserId: 'app-u', browserRuntimeId: 'rt-u' });
  assert.equal(calls[0].url, 'https://holo/api/public/update_user_attributes');
  assert.deepEqual(calls[0].body, {
    api_key: 'KEY123',
    api_key_secret: SECRET,
    user_id: 'kasm-user',
    target_user_attributes: { custom_attribute_1: 'app-u', custom_attribute_2: 'rt-u' },
  });
});

test('list users parsing finds by exact username (local filter)', async () => {
  const calls = [];
  const c = client(calls, {
    transport: async (req) => {
      calls.push(req);
      return { status: 200, json: { users: [{ user_id: 'ku', username: 'vnoctis-x' }], total: 1 } };
    },
  });
  const found = await c.findUserByUsername('vnoctis-x');
  assert.equal(found.user_id, 'ku');
  assert.equal(calls[0].url, 'https://holo/api/public/get_users');
  // filters field 500s live, so it must NOT be sent; filtering is local.
  assert.equal(calls[0].body.filters, undefined);
  assert.equal(calls[0].body.page_size, 250);

  const missing = await c.findUserByUsername('nope');
  assert.equal(missing, null);
});

test('getUsers never sends page and page_size together (live empty-result bug)', async () => {
  const calls = [];
  const c = client(calls);
  await c.getUsers();
  assert.equal(calls[0].body.page, undefined);
  assert.equal(calls[0].body.page_size, 100);

  await c.getUsers({ page: 2 });
  assert.equal(calls[1].body.page, 2);
  assert.equal(calls[1].body.page_size, 100);
});

test('getRecentKasms normalizes a literal null body to an empty array)', async () => {
  const calls = [];
  const c = client(calls, {
    transport: async (req) => {
      calls.push(req);
      return { status: 200, json: null, raw: 'null' };
    },
  });
  assert.deepEqual((await c.getRecentKasms()).kasms, []);
  assert.equal(calls[0].url, 'https://holo/api/public/get_recent_kasms');
  assert.equal(calls[0].body.page, undefined);
});

test('image lookup parsing matches hex or dashed ids', async () => {
  const calls = [];
  const c = client(calls, {
    transport: async (req) => {
      calls.push(req);
      return { status: 200, json: { images: [{ image_id: IMAGE_HEX, friendly_name: 'VN Runner Noble' }] } };
    },
  });
  const byHex = await c.findImage(IMAGE_HEX);
  assert.equal(byHex.friendly_name, 'VN Runner Noble');
  const byDashed = await c.findImage(IMAGE_DASHED);
  assert.equal(byDashed.image_id, IMAGE_HEX);
  const byName = await c.findImage('VN Runner Noble');
  assert.equal(byName.image_id, IMAGE_HEX);
});

test('create user request shape', async () => {
  const calls = [];
  await client(calls).createUser({ username: 'vnoctis-y' });
  assert.equal(calls[0].url, 'https://holo/api/public/create_user');
  assert.equal(calls[0].body.username, 'vnoctis-y');
  assert.equal(calls[0].body.api_key, 'KEY123');
});

test('getImages and getRecentKasms parse documented response envelopes', async () => {
  const calls = [];
  const c = client(calls, {
    transport: async (req) => {
      calls.push(req);
      if (req.url.endsWith('get_images')) return { status: 200, json: { images: [1, 2] } };
      return { status: 200, json: { kasms: [] } };
    },
  });
  assert.deepEqual((await c.getImages()).images, [1, 2]);
  assert.deepEqual((await c.getRecentKasms()).kasms, []);
  assert.equal(calls[0].url, 'https://holo/api/public/get_images');
  assert.equal(calls[1].url, 'https://holo/api/public/get_recent_kasms');
});

test('API errors surface a structured code and message without secrets', async () => {
  const calls = [];
  const c = createKasmClient({
    baseUrl: 'https://holo',
    apiKey: 'KEY123',
    apiKeySecret: SECRET,
    transport: recordingTransport(calls, { status: 400, json: { error_message: 'Invalid kasm_id' } }),
  });
  await assert.rejects(c.getSessionStatus('bad'), (err) => {
    assert.equal(err.code, 'KASM_API_ERROR');
    assert.equal(err.status, 400);
    assert.match(err.message, /Invalid kasm_id/);
    assert.equal(String(err.message).includes(SECRET), false);
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
    imageId: IMAGE_DASHED,
    transport: recordingTransport(calls),
    logger,
  });
  await c.requestSession({ userId: 'u' });
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('KEY123'), false);
});

test('TLS uses explicit CA trust and keeps normal verification', async (t) => {
  assert.deepEqual(buildTlsOptions(null), {});
  assert.deepEqual(buildTlsOptions(''), {});

  const dir = mkdtempSync(join(tmpdir(), 'vnm-kasm-ca-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const caPath = join(dir, 'kasm.crt');
  writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');

  const tls = buildTlsOptions(caPath);
  assert.ok(Array.isArray(tls.ca));
  assert.equal(tls.rejectUnauthorized, undefined); // secure default preserved
  assert.equal(typeof createHttpsTransport({ caPath }), 'function');
});

test('normalizeImageId is idempotent for hex and strips dashes', () => {
  assert.equal(normalizeImageId(IMAGE_DASHED), IMAGE_HEX);
  assert.equal(normalizeImageId(IMAGE_HEX), IMAGE_HEX);
});

test('client exposes non-secret capability flags', () => {
  const calls = [];
  const c = client(calls);
  assert.equal(c.hasCredentials, true);
  assert.equal(c.imageId, IMAGE_HEX);
  assert.equal(c.apiPrefix, '/api/public');
  const incomplete = createKasmClient({ baseUrl: 'https://holo', transport: recordingTransport(calls) });
  assert.equal(incomplete.hasCredentials, false);
  assert.equal(incomplete.hasCa, false);
});
