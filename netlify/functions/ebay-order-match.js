// netlify/functions/ebay-order-match.js
// POST /api/ebay-order-match
// body: { line_item_id, action: 'confirm' | 'ignore' | 'unlink', inventory_id? }
//  confirm: link the line to inventory_id (or its current suggestion) and mark that card sold
//  ignore:  this sale has no inventory row (e.g. supplies), stop suggesting
//  unlink:  undo a match and put the card back in stock

import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin } from '../lib/ebay-seller.js';
import { recompute, markInventorySold, releaseInventory } from '../lib/ebay-orders.js';
import { requireFeature } from '../lib/billing.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();

  { const no = await requireFeature(db, userId, 'profit'); if (no) return no; }
  const { line_item_id, action, inventory_id } = (await req.json().catch(() => null)) || {};
  if (!line_item_id || !['confirm', 'ignore', 'unlink'].includes(action)) return json({ error: 'line_item_id and a valid action are required' }, 400);

  const { data: line, error } = await db.from('ebay_order_lines').select('*').eq('user_id', userId).eq('line_item_id', line_item_id).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!line) return json({ error: 'Sale not found' }, 404);

  try {
    if (action === 'confirm') {
      const invId = inventory_id || line.inventory_id;
      if (!invId) return json({ error: 'inventory_id is required' }, 400);
      const { data: inv } = await db.from('inventory').select('id, status, ebay_order_line_id').eq('user_id', userId).eq('id', invId).maybeSingle();
      if (!inv) return json({ error: 'Inventory item not found' }, 404);
      if (inv.ebay_order_line_id && inv.ebay_order_line_id !== line_item_id) return json({ error: 'That card is already linked to another sale' }, 409);
      if (inv.status === 'Sold' && inv.ebay_order_line_id !== line_item_id) return json({ error: 'That card is already marked sold. Pick the card that was in stock.' }, 409);
      // Moving this sale to a different card: put the previously linked card back in stock first.
      // (Otherwise it stays "Sold" for a sale it wasn't part of, and the unique sale link blocks the move.)
      if (line.inventory_id && line.inventory_id !== invId) await releaseInventory(db, userId, line.inventory_id, line_item_id);
      const { data: order } = await db.from('ebay_orders').select('created_at_ebay').eq('user_id', userId).eq('order_id', line.order_id).maybeSingle();
      await markInventorySold(db, userId, invId, line, order);
      await db.from('ebay_order_lines').update({
        inventory_id: invId, match_status: 'confirmed', match_method: inventory_id && inventory_id !== line.inventory_id ? 'manual' : line.match_method || 'manual',
      }).eq('user_id', userId).eq('line_item_id', line_item_id);
    } else if (action === 'ignore') {
      await db.from('ebay_order_lines').update({ inventory_id: null, match_status: 'ignored', match_method: null })
        .eq('user_id', userId).eq('line_item_id', line_item_id);
    } else {
      if (line.inventory_id && ['auto', 'confirmed'].includes(line.match_status)) {
        await releaseInventory(db, userId, line.inventory_id, line_item_id);
      }
      // 'ignored' so the next sync doesn't immediately re-match the same card.
      await db.from('ebay_order_lines').update({ inventory_id: null, match_status: 'ignored', match_method: null })
        .eq('user_id', userId).eq('line_item_id', line_item_id);
    }
    await recompute(db, userId, [line.order_id]);
    return json({ ok: true });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

export const config = { path: '/api/ebay-order-match' };
