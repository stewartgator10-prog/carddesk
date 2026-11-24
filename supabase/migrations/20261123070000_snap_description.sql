-- Snap to List: the eBay description is now prose about the card, written at identify time and editable on the card.
alter table public.snap_items add column if not exists description text;
