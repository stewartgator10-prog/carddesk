// netlify/functions/access-keys.js
// Personal access keys for AI apps (signed-in seller only; a key can't create or see keys).
//   GET    /api/access-keys            list active keys (name, prefix, created, last used)
//   POST   /api/access-keys { name }    create one; the response holds the key, shown once
//   DELETE /api/access-keys?id=...      revoke one
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { createKey, listKeys, revokeKey } from '../lib/access-keys.js';
import { requireFeature, requireCards } from '../lib/billing.js';

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const db = getSupabaseAdmin();
  const userId = auth.user.id;
  try {
    if (req.method === 'GET') return json(200, { keys: await listKeys({ db, userId }) });
    if (req.method === 'POST') {
      { const no = await requireFeature(db, userId, 'connector'); if (no) return no; }

      const body = (await req.json().catch(() => null)) || {};
      return json(200, { key: await createKey({ db, user: auth.user, name: body.name }) });
    }
    if (req.method === 'DELETE') return json(200, await revokeKey({ db, userId, id: new URL(req.url).searchParams.get('id') || '' }));
    return json(405, { error: 'Use GET, POST or DELETE.' });
  } catch (err) {
    return json(err.status || 500, { error: err.message });
  }
};

export const config = { path: '/api/access-keys' };
