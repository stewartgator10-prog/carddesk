-- Listings made on eBay before CardDesk can be brought in as Snap cards (status 'listed') so their
-- photos, title and description can be edited and sent back to eBay.
--   ebay_live            what eBay currently shows: { "title": ..., "description": ... }. A card whose
--                        title or description differs has changes that aren't on eBay yet.
--   imported_from_ebay_at when the card was brought in from an existing eBay listing (null for cards
--                        snapped in CardDesk).
alter table public.snap_items add column if not exists ebay_live jsonb;
alter table public.snap_items add column if not exists imported_from_ebay_at timestamptz;

-- Cards already listed from CardDesk: what is on eBay is what the card holds now.
update public.snap_items set ebay_live = jsonb_build_object('title', title, 'description', description)
 where status = 'listed' and ebay_live is null;

create index if not exists snap_items_user_ebay_item on public.snap_items (user_id, ebay_item_id) where ebay_item_id is not null;
