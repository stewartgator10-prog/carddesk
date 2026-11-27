// Card photo straightening: corner refinement, perspective warp, white corners, card unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { refineCorners, warpCard, cropCardPhoto, validCorners, outputAspect, decodeJpeg } from '../netlify/lib/photo-crop.js';

// A dark "table" with a tilted light card (a quad) and a red stripe across the card's top third.
function scene(W = 800, H = 600, quad = { tl: [250, 110], tr: [540, 140], br: [510, 520], bl: [215, 490] }) {
  const data = new Uint8Array(W * H * 4);
  const pts = ['tl', 'tr', 'br', 'bl'].map((k) => quad[k]);
  const inside = (x, y) => {
    for (let i = 0; i < 4; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4]; if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false; }
    return true;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    let c = [40, 45, 50];
    if (inside(x, y)) {
      // position along the card's left edge -> stripe near the top
      const t = (y - quad.tl[1]) / (quad.bl[1] - quad.tl[1]);
      c = t > 0.2 && t < 0.3 ? [200, 30, 30] : [225, 215, 160];
    }
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  const frac = Object.fromEntries(Object.entries(quad).map(([k, [x, y]]) => [k, { x: x / W, y: y / H }]));
  return { img: { width: W, height: H, data }, frac };
}

test('corners: valid quads only', () => {
  assert.ok(validCorners({ tl: { x: 0.2, y: 0.1 }, tr: { x: 0.8, y: 0.1 }, br: { x: 0.8, y: 0.9 }, bl: { x: 0.2, y: 0.9 } }));
  assert.ok(!validCorners({ tl: { x: 0.2, y: 0.1 }, tr: { x: 0.21, y: 0.1 }, br: { x: 0.21, y: 0.11 }, bl: { x: 0.2, y: 0.11 } }));   // tiny
  assert.ok(!validCorners({ tl: { x: 0.8, y: 0.1 }, tr: { x: 0.2, y: 0.1 }, br: { x: 0.8, y: 0.9 }, bl: { x: 0.2, y: 0.9 } }));     // crossed
  assert.ok(!validCorners(null));
  assert.equal(outputAspect({ game: 'pokemon' }), 63 / 88);
  assert.equal(outputAspect({ game: 'yugioh' }), 59 / 86);
});

test('refinement moves rough AI corners onto the real card edges', () => {
  const { img, frac } = scene();
  const rough = Object.fromEntries(Object.entries(frac).map(([k, v], i) => [k, { x: v.x + (i % 2 ? 0.018 : -0.015), y: v.y + (i < 2 ? -0.02 : 0.016) }]));
  const fixed = refineCorners(img, rough);
  const err = (c) => Math.max(...Object.keys(frac).map((k) => Math.hypot((c[k].x - frac[k].x) * img.width, (c[k].y - frac[k].y) * img.height)));
  assert.ok(err(rough) > 12, `rough error ${err(rough)}`);
  assert.ok(err(fixed) < 5, `refined error ${err(fixed)} px`);
});

test('the straightened card fills the image, corners are white, and the card itself is unchanged', () => {
  const { img, frac } = scene();
  const out = warpCard(img, frac, { aspect: 63 / 88, outWidth: 630 });
  assert.deepEqual([out.width, out.height], [630, 880]);
  const px = (x, y) => Array.from(out.data.slice((y * out.width + x) * 4, (y * out.width + x) * 4 + 3));
  assert.deepEqual(px(1, 1), [255, 255, 255]);                         // rounded corner: white
  assert.deepEqual(px(out.width - 2, out.height - 2), [255, 255, 255]);
  const body = px(315, 600), stripe = px(315, 220), edge = px(40, 700);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
  assert.ok(near(body, [225, 215, 160]), `card colour kept: ${body}`);   // no colour change
  assert.ok(near(stripe, [200, 30, 30]), `stripe kept: ${stripe}`);
  assert.ok(near(edge, [225, 215, 160]), `card reaches the edge: ${edge}`); // no table left along the sides
});

test('the whole job on a JPEG: refine, straighten, encode; bad corners are refused', () => {
  const { img, frac } = scene();
  const bytes = Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, 92).data);
  const r = cropCardPhoto(bytes, frac, { game: 'yugioh' });
  assert.equal(r.width, 1200);
  assert.equal(r.height, Math.round(1200 / (59 / 86)));
  const back = decodeJpeg(r.jpeg);
  assert.deepEqual([back.width, back.height], [r.width, r.height]);
  assert.throws(() => cropCardPhoto(bytes, { tl: { x: 0.1, y: 0.1 } }), /don't outline a card/);
});
