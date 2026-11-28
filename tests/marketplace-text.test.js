// The sentences a card shows after it sells somewhere, and its marketplace chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saleSentence, chipsFor } from '../netlify/lib/marketplace-text.js';

const eb = (over = {}) => ({ id: 'e', marketplace: 'ebay', status: 'ended', ended_reason: 'sold_elsewhere', price: 12.5, quantity: 0, ...over });
const wn = (over = {}) => ({ id: 'w', marketplace: 'whatnot', status: 'sold', price: 12.5, quantity: 0, ...over });
const note = (over = {}) => ({ marketplace: 'whatnot', at: '2026-11-28T14:55:00Z', price: 14, quantity: 1, quantity_left: 0, ended: [{ marketplace: 'ebay', ok: true }], updated: [], double_sale: false, orders: [], ...over });

test('sold, and the other listing came down', () => {
  assert.equal(saleSentence({ quantity: 0, sale_note: note() }, [eb(), wn()]).text, 'Sold on Whatnot Nov 28 for $14.00. Ended on eBay automatically.');
});

test('sold, but the other listing is still up: red, with an End button', () => {
  const s = saleSentence({ quantity: 0, sale_note: note({ ended: [{ marketplace: 'ebay', ok: false, error: 'eBay said: Internal error.' }] }) }, [eb({ status: 'active' }), wn()]);
  assert.equal(s.tone, 'bad');
  assert.equal(s.text, 'Sold on Whatnot. Your eBay listing is still up: eBay said: Internal error.');
  assert.deepEqual(s.endButtons, [{ listingId: 'e', label: 'End on eBay' }]);
  // once it has ended (retry or button), the normal sentence comes back
  assert.equal(saleSentence({ quantity: 0, sale_note: note({ ended: [{ marketplace: 'ebay', ok: false, error: 'x' }] }) }, [eb(), wn()]).tone, 'ok');
});

test('sold on both before we could end one; stock left; cancelled', () => {
  const d = saleSentence({ quantity: 0, sale_note: note({ double_sale: true, orders: [{ marketplace: 'ebay', url: 'https://e' }, { marketplace: 'whatnot', url: 'https://w' }] }) }, []);
  assert.equal(d.text, 'Sold on both eBay and Whatnot. You only have 1. Cancel one of the orders on that marketplace.');
  assert.equal(d.orders.length, 2);
  assert.equal(saleSentence({ quantity: 2, sale_note: note({ quantity_left: 2, ended: [], updated: [{ marketplace: 'ebay', ok: true }] }) }, []).text, 'Sold 1 on Whatnot. 2 left, updated on eBay.');
  assert.equal(saleSentence({ quantity: 0, sale_note: note({ cancelled: true }) }, []).text, 'The Whatnot order was cancelled. Relist on eBay?');
  assert.equal(saleSentence({ quantity: 1, sale_note: note({ cancelled: true, restored: true }) }, []).text, 'The Whatnot order was cancelled, so the card is back in stock.');
  assert.equal(saleSentence({ sale_note: null }, []), null);
});

test('chips: live with price, ended, sold, not listed; the newest per marketplace', () => {
  const chips = chipsFor([eb({ status: 'active', quantity: 3 }), wn({ status: 'ended', ended_reason: 'seller', updated_at: '2026-11-01' }), wn({ id: 'w2', status: 'active', updated_at: '2026-11-02' })]);
  assert.deepEqual(chips.map((c) => [c.text, c.tone]), [['eBay · $12.50 · 3 left', 'live'], ['Whatnot · $12.50', 'live']]);
  assert.deepEqual(chipsFor([eb(), wn()]).map((c) => c.text), ['Ended on eBay', 'Sold on Whatnot']);
  assert.equal(chipsFor([wn({ status: 'failed' })])[0].text, 'Not listed on Whatnot');
});
