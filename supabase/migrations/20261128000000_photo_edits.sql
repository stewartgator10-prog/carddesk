-- Straighten-and-crop edits on listing photos. The edited copy is a new file; this remembers where
-- each one came from so it can be undone: { "<edited path>": { "original": "<path>", "corners": {...}, "by": "ai"|"manual", "at": "..." } }
alter table public.snap_items add column if not exists photo_edits jsonb not null default '{}'::jsonb;
