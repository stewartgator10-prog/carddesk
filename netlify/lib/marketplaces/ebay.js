// netlify/lib/marketplaces/ebay.js
// eBay behind the marketplace contract, wrapping the existing code. eBay keeps its own connect flow
// (OAuth, ebay_accounts) and its own check-then-publish flow (snap-publish), so connect and
// createListing point the seller there. The rest is used by "sell once".
// ctx.call (Trading API) and ctx.fetchImpl (REST) are injectable; ctx.token skips the token lookup.
import { MarketplaceError } from './errors.js';
import { getSellerAccessToken } from '../ebay-seller.js';
import { endFixedPriceItem } from '../ebay-listing.js';
import { tradingCall, revisePrices, reviseQuantity } from '../trading-price.js';
import { syncEbayOrders, ebaySaleLines } from '../ebay-orders.js';

async function tokenFor(ctx) {
  if (ctx.token) return ctx.token;
  try { return await getSellerAccessToken(ctx.db, ctx.userId); } catch (e) {
    if (e.code === 'EBAY_NOT_CONNECTED') throw new MarketplaceError('reconnect', 'eBay isn\'t connected. Connect it in Marketplaces.');
    if (e.code === 'EBAY_RECONNECT') throw new MarketplaceError('reconnect', 'eBay sign-in expired. Reconnect eBay in Marketplaces.');
    throw new MarketplaceError('unavailable', 'Couldn\'t reach eBay. Try again in a minute.');
  }
}

const said = (e) => new MarketplaceError('rejected', `eBay said: ${String(e?.message || 'the change was refused').slice(0, 200)}`);

export const ebay = {
  id: 'ebay',
  label: 'eBay',
  authKinds: ['oauth'],

  async connect() { throw new MarketplaceError('not_set_up', 'Connect eBay with the Connect eBay button.'); },
  async createListing() { throw new MarketplaceError('rejected', 'List on eBay with Check and Publish on the card.'); },

  async updateListing(ctx, listing, { price, quantity } = {}) {
    const token = await tokenFor(ctx);
    const call = ctx.call || tradingCall;
    const out = { price: listing.price != null ? Number(listing.price) : null, quantity: listing.quantity };
    if (price != null) {
      const [r] = await revisePrices(token, [{ itemId: listing.external_id, oldPrice: listing.price, newPrice: Number(price) }], call);
      if (!r?.ok) throw said({ message: r?.error });
      out.price = Number(r.price);
    }
    if (quantity != null) {
      try { out.quantity = (await reviseQuantity(token, { itemId: listing.external_id, quantity }, call)).quantity; } catch (e) { throw said(e); }
    }
    const patch = { ...(price != null ? { price: out.price } : {}), ...(quantity != null ? { quantity_available: out.quantity } : {}) };
    if (Object.keys(patch).length) await ctx.db.from('ebay_listings').update(patch).eq('user_id', ctx.userId).eq('item_id', listing.external_id);
    return out;
  },

  async endListing(ctx, listing) {
    const token = await tokenFor(ctx);
    let r;
    try { r = await endFixedPriceItem(token, listing.external_id, ctx.call || tradingCall); } catch (e) { throw said(e); }
    await ctx.db.from('ebay_listings').update({ status: 'Ended', end_time: new Date().toISOString() }).eq('user_id', ctx.userId).eq('item_id', listing.external_id);
    return { ok: true, ...(r.gone ? { gone: true } : {}) };
  },

  // Orders changed in the last two hours (orders only; the seller's own sync adds fees later).
  async fetchSales(ctx, { windowMs = 2 * 3600_000 } = {}) {
    const token = await tokenFor(ctx);
    const fromIso = new Date(Date.now() - windowMs).toISOString();
    try {
      const { orders, lines } = await syncEbayOrders({ db: ctx.db, userId: ctx.userId, token, fromIso, withFinances: false, fetchImpl: ctx.fetchImpl || fetch });
      return ebaySaleLines(orders, lines);
    } catch (e) {
      if (e.status === 401) throw new MarketplaceError('reconnect', 'eBay sign-in expired. Reconnect eBay in Marketplaces.');
      throw new MarketplaceError('unavailable', 'Couldn\'t read eBay orders. We\'ll try again on the next check.');
    }
  },
};
