-- Snap to List: Yu-Gi-Oh!, One Piece, Lorcana and other card games.
-- Rarity matters for these games (one set code can be printed in several rarities), so it gets its own column.
alter table public.snap_items add column if not exists rarity text;
