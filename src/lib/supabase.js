// PROVISIONAL STAND-IN. The real file comes from the "Move carddesk data to
// Supabase" branch; when merging, keep that version.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = url && key ? createClient(url, key) : null;
