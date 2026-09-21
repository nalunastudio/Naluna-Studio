// lib/meta-capi/capi-retry.js — logica PURA de backoff, acelasi tipar de test ca
// test/social-retry.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ATTEMPTS, computeBackoffMs, computeNextAttempt } = require('../lib/meta-capi/capi-retry');

test('computeBackoffMs: exponential, plafonat la 60 minute', () => {
  assert.equal(computeBackoffMs(1), 2 * 60 * 1000);
  assert.equal(computeBackoffMs(2), 4 * 60 * 1000);
  assert.equal(computeBackoffMs(3), 8 * 60 * 1000);
  assert.equal(computeBackoffMs(10), 60 * 60 * 1000, 'plafonat la 60 minute, niciodata mai mult');
});

test('computeNextAttempt: fiecare incercare succesiva programeaza urmatoarea tot mai tarziu', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const next1 = computeNextAttempt(1, now);
  const next2 = computeNextAttempt(2, now);
  const next3 = computeNextAttempt(3, now);
  assert.ok(next1.getTime() > now.getTime());
  assert.ok(next2.getTime() - now.getTime() > next1.getTime() - now.getTime());
  assert.ok(next3.getTime() - now.getTime() > next2.getTime() - now.getTime());
});

test('computeNextAttempt: dupa MAX_ATTEMPTS incercari -> null (renuntare, randul devine abandoned)', () => {
  const now = new Date();
  assert.equal(computeNextAttempt(MAX_ATTEMPTS, now), null);
  assert.equal(computeNextAttempt(MAX_ATTEMPTS + 5, now), null);
  assert.ok(computeNextAttempt(MAX_ATTEMPTS - 1, now) instanceof Date, 'chiar sub plafon, tot trebuie programata o reincercare');
});
