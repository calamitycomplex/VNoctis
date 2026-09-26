import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED_TRANSITIONS,
  RUNTIME_STATES,
  canTransition,
  isStoredRuntimeState,
  nextRuntimeStates,
  normalizeRuntimeState,
  serializeBrowserRuntime,
} from './browserRuntime.js';

test('RUNTIME_STATES covers the full lifecycle including the derived absence state', () => {
  assert.deepEqual(RUNTIME_STATES, [
    'ARCHIVE_ONLY', 'REQUESTED', 'PREPARING', 'TESTING', 'READY', 'BROKEN', 'UNSUPPORTED',
  ]);
  assert.equal(isStoredRuntimeState('ARCHIVE_ONLY'), false);
  assert.equal(isStoredRuntimeState('READY'), true);
  assert.equal(isStoredRuntimeState('NOPE'), false);
});

test('normalizeRuntimeState maps a missing row to ARCHIVE_ONLY', () => {
  assert.equal(normalizeRuntimeState(undefined), 'ARCHIVE_ONLY');
  assert.equal(normalizeRuntimeState(null), 'ARCHIVE_ONLY');
  assert.equal(normalizeRuntimeState('TESTING'), 'TESTING');
});

test('normal path transitions are allowed', () => {
  assert.ok(canTransition('ARCHIVE_ONLY', 'REQUESTED'));
  assert.ok(canTransition('REQUESTED', 'PREPARING'));
  assert.ok(canTransition('PREPARING', 'TESTING'));
  assert.ok(canTransition('TESTING', 'READY'));
});

test('admin exception transitions are allowed', () => {
  assert.ok(canTransition('REQUESTED', 'UNSUPPORTED'));
  assert.ok(canTransition('PREPARING', 'BROKEN'));
  assert.ok(canTransition('TESTING', 'BROKEN'));
  assert.ok(canTransition('BROKEN', 'PREPARING'));
  assert.ok(canTransition('UNSUPPORTED', 'REQUESTED'));
  assert.ok(canTransition('UNSUPPORTED', 'PREPARING'));
});

test('invalid transitions are rejected, and same-state is a no-op', () => {
  assert.equal(canTransition('ARCHIVE_ONLY', 'READY'), false);
  assert.equal(canTransition('REQUESTED', 'READY'), false);
  assert.equal(canTransition('READY', 'PREPARING'), false);
  assert.equal(canTransition('READY', 'REQUESTED'), false);
  assert.equal(canTransition('PREPARING', 'REQUESTED'), false);
  assert.ok(canTransition('READY', 'READY'));
});

test('READY is terminal and nextRuntimeStates never invents targets', () => {
  assert.deepEqual(nextRuntimeStates('READY'), []);
  assert.deepEqual(nextRuntimeStates(undefined), ['REQUESTED', 'PREPARING']);
  assert.deepEqual(Object.keys(ALLOWED_TRANSITIONS).sort(), RUNTIME_STATES.slice().sort());
});

test('serializeBrowserRuntime exposes ARCHIVE_ONLY with counts and no identities', () => {
  const block = serializeBrowserRuntime(null, [{ userId: 'a' }, { userId: 'b' }], 'a');
  assert.deepEqual(block, {
    state: 'ARCHIVE_ONLY',
    archiveItemId: null,
    note: null,
    createdAt: null,
    updatedAt: null,
    requestCount: 2,
    requestedByCurrentUser: true,
  });
});

test('serializeBrowserRuntime is safe with missing/undefined request lists', () => {
  const block = serializeBrowserRuntime({ state: 'BROKEN', note: 'n' }, undefined, null);
  assert.equal(block.state, 'BROKEN');
  assert.equal(block.requestCount, 0);
  assert.equal(block.requestedByCurrentUser, false);
  assert.equal(block.note, 'n');
});
