import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { seal, open, boxKey, hasBoxKey } from '../netlify/lib/secret-box.js';

const key = crypto.randomBytes(32);

test('a sealed token opens back to the same text, and never contains it', () => {
  const tok = 'wn_pat_tk_abc123SECRET';
  const s = seal(tok, key);
  assert.match(s, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!s.includes(tok));
  assert.notEqual(seal(tok, key), s);   // fresh IV each time
  assert.equal(open(s, key), tok);
});

test('a changed value or the wrong key fails without echoing anything', () => {
  const s = seal('wn_pat_tk_secret', key);
  const parts = s.split('.');
  const flipped = Buffer.from(parts[3], 'base64url'); flipped[0] ^= 1;
  const tampered = [...parts.slice(0, 3), flipped.toString('base64url')].join('.');
  assert.throws(() => open(tampered, key), (e) => e.code === 'OPEN_FAILED' && !e.message.includes('secret'));
  assert.throws(() => open(s, crypto.randomBytes(32)), /could not be opened/);
  assert.throws(() => open('plain-token', key), /format/);
});

test('a missing or short key throws a clear error', () => {
  assert.throws(() => boxKey({}), (e) => e.code === 'NO_KEY');
  assert.throws(() => boxKey({ MARKETPLACE_TOKEN_KEY: Buffer.from('short').toString('base64') }), (e) => e.code === 'BAD_KEY');
  assert.equal(hasBoxKey({}), false);
  assert.equal(hasBoxKey({ MARKETPLACE_TOKEN_KEY: key.toString('base64') }), true);
  assert.equal(boxKey({ MARKETPLACE_TOKEN_KEY: key.toString('base64') }).length, 32);
});
