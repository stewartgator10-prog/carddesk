-- Snap to List: more than one photo per listing.
-- photo_path stays the main photo (the one the AI identifies and eBay shows first);
-- extra_photo_paths holds the rest, in the order they go on eBay.
alter table public.snap_items add column if not exists extra_photo_paths text[] not null default '{}';

-- The single optional back photo becomes the first extra photo.
update public.snap_items
   set extra_photo_paths = array[back_photo_path]
 where back_photo_path is not null and extra_photo_paths = '{}';
