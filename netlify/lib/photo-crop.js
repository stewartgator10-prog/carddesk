// netlify/lib/photo-crop.js
// Turns a phone photo of a card into a listing photo: the card straightened and filling the frame,
// with clean white in the rounded corners. Only geometry changes: no colour, sharpness or any other
// change to how the card itself looks.
//
//   corners  the card's four corners as fractions of the photo: { tl, tr, br, bl } each { x, y }
//   refine   nudges AI-estimated corners onto the card's real edges (strongest straight edge nearby)
//   warp     maps the four corners onto an upright rectangle (perspective transform, bilinear)
import jpeg from 'jpeg-js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function decodeJpeg(bytes) {
  const img = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  return { width: img.width, height: img.height, data: img.data };
}
export const encodeJpeg = (img, quality = 90) => Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data);

// Card proportions: 63 x 88 mm for most games, 59 x 86 mm for Yu-Gi-Oh!. Slabs keep their own shape.
export function outputAspect({ game, graded, corners, width, height }) {
  if (graded && corners) {
    const p = toPixels(corners, width, height);
    const w = (dist(p.tl, p.tr) + dist(p.bl, p.br)) / 2, h = (dist(p.tl, p.bl) + dist(p.tr, p.br)) / 2;
    return clamp(w / h, 0.45, 1);
  }
  return game === 'yugioh' ? 59 / 86 : 63 / 88;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const toPixels = (c, w, h) => Object.fromEntries(['tl', 'tr', 'br', 'bl'].map((k) => [k, { x: c[k].x * w, y: c[k].y * h }]));

export function validCorners(c) {
  if (!c || typeof c !== 'object') return false;
  const ks = ['tl', 'tr', 'br', 'bl'];
  if (!ks.every((k) => c[k] && Number.isFinite(c[k].x) && Number.isFinite(c[k].y) && c[k].x >= -0.05 && c[k].x <= 1.05 && c[k].y >= -0.05 && c[k].y <= 1.05)) return false;
  // A real card covers a decent part of the photo and its corners go round in order (no crossed shape).
  const p = ks.map((k) => c[k]);
  let area = 0;
  for (let i = 0; i < 4; i++) area += p[i].x * p[(i + 1) % 4].y - p[(i + 1) % 4].x * p[i].y;
  return area / 2 > 0.04;
}

// Grayscale at full size for the edge search.
function gray(img) {
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2];
  return g;
}
const sample = (g, w, h, x, y) => {
  const xi = clamp(Math.round(x), 0, w - 1), yi = clamp(Math.round(y), 0, h - 1);
  return g[yi * w + xi];
};

// For each side, try lines near the estimate (shifted and slightly tilted) and keep the one with the
// strongest, most consistent brightness step across it. The corners are where the four lines meet.
export function refineCorners(img, corners, { search = 0.035, steps = 14, tilts = 5 } = {}) {
  const { width: w, height: h } = img;
  const g = gray(img);
  const p = toPixels(corners, w, h);
  const center = { x: (p.tl.x + p.tr.x + p.br.x + p.bl.x) / 4, y: (p.tl.y + p.tr.y + p.br.y + p.bl.y) / 4 };
  const reach = search * Math.max(w, h);
  const sides = [['tl', 'tr'], ['tr', 'br'], ['br', 'bl'], ['bl', 'tl']];
  const lines = sides.map(([a, b]) => {
    const A = p[a], B = p[b];
    const len = dist(A, B) || 1;
    const dir = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    let nrm = { x: -dir.y, y: dir.x };
    const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    if ((center.x - mid.x) * nrm.x + (center.y - mid.y) * nrm.y < 0) nrm = { x: -nrm.x, y: -nrm.y };   // normal points into the card
    let best = { score: -Infinity, A, B };
    for (let t = -tilts; t <= tilts; t++) {
      const tilt = (t / tilts) * reach * 0.5;
      for (let s = -steps; s <= steps; s++) {
        const off = (s / steps) * reach;
        const a = { x: A.x + nrm.x * (off - tilt), y: A.y + nrm.y * (off - tilt) };
        const b = { x: B.x + nrm.x * (off + tilt), y: B.y + nrm.y * (off + tilt) };
        let sum = 0, n = 0;
        for (let k = 0.08; k <= 0.92; k += 0.02) {              // skip the rounded corners
          const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
          const inside = sample(g, w, h, x + nrm.x * 3, y + nrm.y * 3), outside = sample(g, w, h, x - nrm.x * 3, y - nrm.y * 3);
          sum += Math.abs(inside - outside); n += 1;
        }
        const score = sum / n - Math.abs(off) / reach * 2;       // prefer the AI's line when steps are close
        if (score > best.score) best = { score, A: a, B: b };
      }
    }
    return best;
  });
  const meet = (l1, l2) => {
    const x1 = l1.A.x, y1 = l1.A.y, x2 = l1.B.x, y2 = l1.B.y, x3 = l2.A.x, y3 = l2.A.y, x4 = l2.B.x, y4 = l2.B.y;
    const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(d) < 1e-6) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  };
  const out = { tl: meet(lines[3], lines[0]), tr: meet(lines[0], lines[1]), br: meet(lines[1], lines[2]), bl: meet(lines[2], lines[3]) };
  if (Object.values(out).some((v) => !v)) return corners;
  const frac = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { x: v.x / w, y: v.y / h }]));
  // Never wander far from the estimate.
  const moved = Math.max(...['tl', 'tr', 'br', 'bl'].map((k) => Math.hypot(frac[k].x - corners[k].x, frac[k].y - corners[k].y)));
  return moved > search * 2.5 || !validCorners(frac) ? corners : frac;
}

// Perspective transform from the unit square to the quad (standard square-to-quad homography).
function squareToQuad(q) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = [q.tl.x, q.tl.y, q.tr.x, q.tr.y, q.br.x, q.br.y, q.bl.x, q.bl.y];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a13 = 0, a23 = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const den = dx1 * dy2 - dx2 * dy1;
    a13 = (dx3 * dy2 - dx2 * dy3) / den;
    a23 = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return { a11: x1 - x0 + a13 * x1, a21: x3 - x0 + a23 * x3, a31: x0, a12: y1 - y0 + a13 * y1, a22: y3 - y0 + a23 * y3, a32: y0, a13, a23 };
}

// Straightens the card into an upright image that it fills edge to edge; the rounded corners are white.
export function warpCard(img, corners, { aspect = 63 / 88, outWidth = 1200, cornerRadius = 0.045 } = {}) {
  const W = Math.round(outWidth), H = Math.round(outWidth / aspect);
  const m = squareToQuad(toPixels(corners, img.width, img.height));
  const out = new Uint8Array(W * H * 4);
  const r = cornerRadius * W, sw = img.width, sh = img.height, src = img.data;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // Outside the rounded corner: white.
      const cx = x < r ? r : x > W - r ? W - r : x, cy = y < r ? r : y > H - r ? H - r : y;
      if ((x < r || x > W - r) && (y < r || y > H - r) && Math.hypot(x - cx, y - cy) > r) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255; continue; }
      const u = (x + 0.5) / W;
      const z = m.a13 * u + m.a23 * v + 1;
      const sx = (m.a11 * u + m.a21 * v + m.a31) / z - 0.5, sy = (m.a12 * u + m.a22 * v + m.a32) / z - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const xa = clamp(x0, 0, sw - 1), xb = clamp(x0 + 1, 0, sw - 1), ya = clamp(y0, 0, sh - 1), yb = clamp(y0 + 1, 0, sh - 1);
      for (let c = 0; c < 3; c++) {
        const p00 = src[(ya * sw + xa) * 4 + c], p10 = src[(ya * sw + xb) * 4 + c], p01 = src[(yb * sw + xa) * 4 + c], p11 = src[(yb * sw + xb) * 4 + c];
        out[o + c] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

// One call for the whole job. Returns the new JPEG and the corners actually used.
export function cropCardPhoto(bytes, corners, { refine = true, game = null, graded = false } = {}) {
  if (!validCorners(corners)) throw Object.assign(new Error('Those corners don\'t outline a card. Drag the four handles onto the card\'s corners.'), { status: 400 });
  const img = decodeJpeg(bytes);
  const used = refine ? refineCorners(img, corners) : corners;
  const aspect = outputAspect({ game, graded, corners: used, width: img.width, height: img.height });
  const out = warpCard(img, used, { aspect, cornerRadius: graded ? 0.02 : 0.045 });
  return { jpeg: encodeJpeg(out, 90), corners: used, width: out.width, height: out.height };
}
