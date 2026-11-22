// src/lib/supabase.js
// Browser Supabase client (anon key only). The Supabase-login work ships the
// full version of this file with the same `supabase` export; keep that one on merge.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
