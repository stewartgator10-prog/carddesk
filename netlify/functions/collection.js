// netlify/functions/collection.js
// Collection (signed-in collector). Items are edited in the browser under row-level security;
// reading photos, pricing and the nightly-style refresh run here.
//   POST /api/collection { action: 'scan', photoPath, kind: 'single' | 'page' }  read, price, add
//   POST /api/collection { action: 'reprice', id }                                 price again after edits
//   POST /api/collection { action: 'refresh' }                                     re-price stale items now
//   POST /api/collection { action: 'recheck' }                                     re-check alerts after target changes
//   POST /api/collection { action: 'list', id }                                    send to Snap to List
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { scanCollectionPhoto, repriceItem, refreshCollection, recheckAlerts, sendToSnap } from '../lib/collection.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  const body = (await req.json().catch(() => null)) || {};
  try {
    switch (body.action) {
      case 'scan': return json(200, await scanCollectionPhoto({ db, userId, photoPath: String(body.photoPath || ''), kind: body.kind }));
      case 'reprice': return json(200, await repriceItem({ db, userId, id: String(body.id || '') }));
      case 'refresh': return json(200, await refreshCollection({ db, userId, force: body.force === true, maxItems: 40, deadlineMs: 20_000 }));
      case 'recheck': return json(200, await recheckAlerts({ db, userId }));
      case 'list': return json(200, await sendToSnap({ db, userId, id: String(body.id || '') }));
      default: return json(400, { error: 'Unknown action.' });
    }
  } catch (err) {
    console.error('collection', err);
    const status = err.code === 'BUDGET' ? 429 : err.code === 'NO_API_KEY' ? 503 : err.status || 502;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/collection' };
