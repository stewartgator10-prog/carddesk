// netlify/lib/ebay-promote.js
// Promoted Listings Standard (cost per sale) through eBay's Marketing API.
// New listings are added to one CardDesk campaign at the seller's ad rate (2% by default). The fee is
// only charged when a promoted listing sells. Needs the sell.marketing permission, which the seller
// grants by reconnecting eBay once; until then promotion is skipped and the card says why.

const MARKETING = 'https://api.ebay.com/sell/marketing/v1';

async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

async function ebayError(res) {
  const t = await res.text().catch(() => '');
  let msg = '';
  try { const j = JSON.parse(t); msg = (j.errors || []).map((e) => e.longMessage || e.message).filter(Boolean).join('; '); } catch { /* not JSON */ }
  return { status: res.status, message: (msg || t.replace(/\s+/g, ' ').trim()).slice(0, 200) || `HTTP ${res.status}` };
}

const needsReconnect = (e) => e.status === 401 || e.status === 403 || /scope|insufficient|access denied|not authorized/i.test(e.message);
export const RECONNECT_FOR_PROMO = 'Promotion needs one more eBay permission: reconnect eBay in Listings & Prices → eBay account, then publish again.';

export const promoRate = (settings = {}) => {
  const n = Number(settings.snapPromotePct ?? 2);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n * 10) / 10, 100) : 0;
};

async function createCampaign({ token, pct, fetchImpl }) {
  const res = await fetchImpl(`${MARKETING}/ad_campaign`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      campaignName: `CardDesk ${pct}% ${new Date().toISOString().slice(0, 10)}`,
      marketplaceId: 'EBAY_US',
      startDate: new Date(Date.now() + 60_000).toISOString(),
      fundingStrategy: { fundingModel: 'COST_PER_SALE', bidPercentage: String(pct) },
    }),
  });
  if (res.status !== 201 && !res.ok) throw Object.assign(new Error('campaign'), { ebay: await ebayError(res) });
  const id = (res.headers.get('location') || '').split('/').pop();
  if (!id) throw Object.assign(new Error('campaign'), { ebay: { status: res.status, message: 'eBay did not return the new campaign' } });
  return id;
}

async function addAd({ token, campaignId, itemId, pct, fetchImpl }) {
  const res = await fetchImpl(`${MARKETING}/ad_campaign/${encodeURIComponent(campaignId)}/ad`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ listingId: String(itemId), bidPercentage: String(pct) }),
  });
  if (res.status === 201 || res.ok) return null;
  return ebayError(res);
}

// Adds one live listing to the seller's CardDesk campaign, creating the campaign the first time (or
// again if the old one ended). Never throws: returns { ok, rate } or { ok: false, error }.
export async function promoteListing({ db, userId, token, itemId, settings, fetchImpl = fetch }) {
  const pct = promoRate(settings);
  if (!pct) return { ok: false, skipped: true, error: null };
  try {
    const acct = await must(db.from('ebay_accounts').select('id, promo_campaign_id').eq('user_id', userId).maybeSingle());
    let campaignId = acct?.promo_campaign_id || null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!campaignId) {
        campaignId = await createCampaign({ token, pct, fetchImpl });
        await must(db.from('ebay_accounts').update({ promo_campaign_id: campaignId }).eq('user_id', userId));
      }
      const err = await addAd({ token, campaignId, itemId, pct, fetchImpl });
      if (!err) return { ok: true, rate: pct, campaignId };
      if (needsReconnect(err)) return { ok: false, error: RECONNECT_FOR_PROMO };
      // The stored campaign was deleted or has ended: start a fresh one once.
      if (attempt === 0 && (err.status === 404 || /campaign/i.test(err.message))) { campaignId = null; continue; }
      return { ok: false, error: `eBay didn't add the promotion: ${err.message}` };
    }
    return { ok: false, error: 'eBay did not accept the promotion campaign.' };
  } catch (e) {
    if (e.ebay && needsReconnect(e.ebay)) return { ok: false, error: RECONNECT_FOR_PROMO };
    return { ok: false, error: `Promotion not added: ${e.ebay?.message || e.message}` };
  }
}
