// lib/recovery-emails/retry.js — backoff pur, ACELASI stil ca test/meta-capi-retry.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ATTEMPTS, computeBackoffMs, computeNextAttempt } = require('../lib/recovery-emails/retry');

test('computeBackoffMs: creste exponential si e plafonat la 30 minute', () => {
  assert.equal(computeBackoffMs(1), 2 * 60 * 1000);
  assert.equal(computeBackoffMs(2), 4 * 60 * 1000);
  assert.equal(computeBackoffMs(3), 8 * 60 * 1000);
  assert.equal(computeBackoffMs(4), 16 * 60 * 1000);
  assert.equal(computeBackoffMs(5), 30 * 60 * 1000, 'plafonat la 30min de la 2^5=32 in sus');
  assert.equal(computeBackoffMs(10), 30 * 60 * 1000);
});

test('computeNextAttempt: null cand attemptCount >= MAX_ATTEMPTS (5) — randul devine abandoned', () => {
  assert.equal(MAX_ATTEMPTS, 5);
  assert.equal(computeNextAttempt(5), null);
  assert.equal(computeNextAttempt(6), null);
});

test('computeNextAttempt: sub plafon -> data viitoare, coerenta cu computeBackoffMs', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const next = computeNextAttempt(1, now);
  assert.equal(next.getTime(), now.getTime() + 2 * 60 * 1000);
});
