// Seller sign-in adapter for the Repricer.
//
// STUB: eBay seller sign-in is being built separately (netlify/lib/ebay-seller.js, which exports
// getSupabaseAdmin, requireUser and getSellerAccessToken, and syncs listings into
// public.ebay_listings). Until that lands, this adapter reports "not connected" and the
// Repricer runs in demo mode against sample listings. Nothing is sent to eBay in demo mode.
//
// To wire it up once ebay-seller.js is merged, replace the body of getSellerContext with:
//
//   import { getSupabaseAdmin, requireUser, getSellerAccessToken } from './ebay-seller.js';
//   const auth = await requireUser(req);
//   if (auth instanceof Response) return { connected: false, reason: 'signed_out' };
//   const admin = getSupabaseAdmin();
//   const token = await getSellerAccessToken(admin, auth.user.id).catch(() => null);
//   if (!token) return { connected: false, reason: 'ebay_not_linked' };
//   return { connected: true, userId: auth.user.id, token, admin };
//
// and listActiveListings / recordPriceChanges will use the Supabase tables below.

// eslint-disable-next-line no-unused-vars
export async function getSellerContext(req) {
  return { connected: false, reason: 'seller_signin_not_built' };
}

export async function listActiveListings(ctx) {
  if (!ctx.connected) return DEMO_LISTINGS;
  const { data, error } = await ctx.admin
    .from('ebay_listings')
    .select('item_id, sku, title, price, quantity_available, image_url, view_url, listing_type, watch_count, start_time')
    .eq('user_id', ctx.userId)
    .order('title');
  if (error) throw new Error(error.message);
  return data.map(r => ({
    itemId: r.item_id, sku: r.sku, title: r.title, price: Number(r.price),
    quantity: r.quantity_available, image: r.image_url, url: r.view_url,
    listingType: r.listing_type, watchers: r.watch_count, startTime: r.start_time,
  }));
}

export async function recordPriceChanges(ctx, results, changes) {
  if (!ctx.connected) return;
  const byId = new Map(changes.map(c => [String(c.itemId), c]));
  const ok = results.filter(r => r.ok);
  if (ok.length) {
    await Promise.all(ok.map(r => ctx.admin.from('ebay_listings')
      .update({ price: r.price }).eq('user_id', ctx.userId).eq('item_id', r.itemId)));
  }
  await ctx.admin.from('price_changes').insert(results.map(r => {
    const c = byId.get(String(r.itemId)) || {};
    return {
      user_id: ctx.userId, item_id: r.itemId, sku: c.sku || null,
      old_price: c.oldPrice ?? null, new_price: c.newPrice, applied: r.ok,
      error: r.error, reason: c.reason || null,
    };
  }));
}

// GUESS: sample listings so the screen is usable before sign-in exists. Not real data.
const DEMO_LISTINGS = [
  { itemId: 'DEMO-1001', sku: null, title: 'Charizard VMAX 020/189 Darkness Ablaze Pokemon NM', price: 54.99, quantity: 1, watchers: 6, listingType: 'FixedPriceItem', startTime: '2026-10-02' },
  { itemId: 'DEMO-1002', sku: null, title: 'Umbreon VMAX Alt Art 215/203 Evolving Skies PSA 10', price: 899.0, quantity: 1, watchers: 21, listingType: 'FixedPriceItem', startTime: '2026-11-01' },
  { itemId: 'DEMO-1003', sku: 'PK-PIK-025', title: 'Pikachu VMAX 044/185 Vivid Voltage Rainbow NM', price: 12.5, quantity: 3, watchers: 0, listingType: 'FixedPriceItem', startTime: '2026-08-14' },
  { itemId: 'DEMO-1004', sku: null, title: 'MTG Ragavan, Nimble Pilferer Modern Horizons 2 LP', price: 41.0, quantity: 1, watchers: 2, listingType: 'FixedPriceItem', startTime: '2026-09-20' },
  { itemId: 'DEMO-1005', sku: null, title: 'Mew ex 151 Special Illustration Rare 205/165 NM', price: 74.0, quantity: 1, watchers: 4, listingType: 'FixedPriceItem', startTime: '2026-11-15' },
  { itemId: 'DEMO-1006', sku: null, title: 'Lugia V Alt Art 186/195 Silver Tempest Auction', price: 60.0, quantity: 1, watchers: 9, listingType: 'Chinese', startTime: '2026-11-20' },
];
