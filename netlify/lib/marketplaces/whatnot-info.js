// netlify/lib/marketplaces/whatnot-info.js
// Whatnot facts the app shows the seller. Browser-safe (no Node imports).
export const TOKEN_PREFIX = 'wn_pat_tk_';
export const APP_TOKEN_PREFIX = 'wn_access_tk_';   // OAuth app tokens, once the partner app exists
// The scopes the spec lists for the calls we make. Shown to the seller to tick when they create the token.
export const WHATNOT_SCOPES = ['read:inventory', 'write:inventory', 'read:merchandising', 'write:merchandising', 'read:orders'];
export const TOKEN_PAGE = 'https://www.whatnot.com/dashboard/developer?tab=tokens';

// Snap condition codes -> Whatnot's words.
export const CONDITION_LABELS = { NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Damaged' };
