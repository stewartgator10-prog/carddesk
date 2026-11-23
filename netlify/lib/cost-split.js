// netlify/lib/cost-split.js
// Pure cost math shared by the server and the browser (no Node-only imports here).

const round2 = (n) => Math.round(n * 100) / 100;

// Splits `total` across cards in proportion to weight (market value), or evenly.
// Works in whole cents and hands leftover cents to the largest remainders, so the parts
// always add up to exactly the total. Cards with no known value get the average weight.
export function splitCost(total, cards, method = 'market') {
  const cents = Math.round(Number(total) * 100);
  if (!cards.length) return new Map();
  const known = cards.map((c) => Number(c.weight)).filter((w) => Number.isFinite(w) && w > 0);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const w = cards.map((c) => (method === 'even' ? 1 : (Number.isFinite(Number(c.weight)) && Number(c.weight) > 0 ? Number(c.weight) : avg)));
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (cents * x) / sum);
  const base = raw.map(Math.floor);
  let left = cents - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left -= 1) base[order[k][1]] += 1;
  return new Map(cards.map((c, i) => [c.id, base[i] / 100]));
}

export const estimateCost = (price, pct) => (Number.isFinite(Number(price)) && Number(price) > 0 ? round2((Number(price) * Number(pct)) / 100) : null);

export function validCost(v) {
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 && n <= 1_000_000;
}
