-- Best Offer on/off per listing, and Promoted Listings for new listings.

-- Last known Best Offer state of each eBay listing (null = not known yet). Set when CardDesk
-- lists a card, when the seller toggles it in the Repricer, and when a price push reads the listing.
alter table public.ebay_listings add column if not exists best_offer boolean;

-- The Promoted Listings Standard campaign CardDesk adds new listings to (created on first use).
alter table public.ebay_accounts add column if not exists promo_campaign_id text;

-- Whether a published card was added to the promotion, or why not.
alter table public.snap_items add column if not exists promoted_at timestamptz;
alter table public.snap_items add column if not exists promo_error text;
