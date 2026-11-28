// netlify/lib/marketplaces/whatnot-details.js
// Which Whatnot category a card goes in, and the card details (Whatnot "attributes") we can fill in
// for it. Pure and browser-safe; the table comes from whatnot-taxonomy.js (generated from Whatnot's
// published taxonomy by scripts/whatnot-taxonomy.mjs).
//
// Every card detail Whatnot lists for a card category is optional. We only send a value Whatnot will
// take: one of the listed values for a fixed list (ENUM), our own text for a free-text detail.
import { TCG_CATEGORIES, TCG_ATTRIBUTES } from './whatnot-taxonomy.js';

const BY_ID = new Map(TCG_CATEGORIES.map((c) => [c.id, c]));
const BY_TYPE = new Map(TCG_CATEGORIES.map((c) => [c.type, c]));

// Our games -> Whatnot category types (ids from taxonomy 1.2.3: 2, 9, 8, 567, 2013).
export const GAME_CATEGORY_TYPES = { pokemon: 'pokemon_cards', mtg: 'magic_cards', yugioh: 'yugioh_cards', one_piece: 'one_piece_cards', lorcana: 'lorcana_cards' };
export const OTHER_CATEGORY_TYPE = 'tcg_other';   // "Kickstarter & Other Cards" (138)
// Other names a seller (or the AI) may use for a game, beyond Whatnot's own label.
const ALIASES = { my_hero_academia: ['universus', 'my hero academia'], weiß_schwarz: ['weiss schwarz', 'weiß schwarz'], flesh_and_blood: ['flesh and blood', 'fab'], gundam_cards: ['gundam'] };
const NOT_A_GAME = new Set([OTHER_CATEGORY_TYPE, 'tcg_accessories']);

// "Dragon Ball Super Card Game" -> "dragon ball super"
export function gameWords(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/ß/g, 'ss').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|official|trading card game|card game|tcg|ccg|cards?|game)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// The TCG category whose name matches a typed game name ("Digimon Card Game" -> Digimon Cards).
export function categoryForGameName(name) {
  const n = gameWords(name);
  if (n.length < 3) return null;
  const has = (a, b) => ` ${a} `.includes(` ${b} `);
  for (const c of TCG_CATEGORIES) {
    if (NOT_A_GAME.has(c.type)) continue;
    const names = [c.label, c.type.replace(/_/g, ' '), ...(ALIASES[c.type] || [])].map(gameWords).filter((x) => x.length >= 3);
    if (names.some((x) => has(n, x) || has(x, n))) return c;
  }
  return null;
}

// The Whatnot category for a card, or null when Whatnot can't take it (sports cards).
// WHATNOT_CATEGORY_IDS (JSON, e.g. {"pokemon":"2"}) on the site still overrides a game's category.
export function categoryFor(card, env = (typeof process !== 'undefined' ? process.env : {})) {
  const game = card?.game;
  let override = {};
  try { override = env?.WHATNOT_CATEGORY_IDS ? JSON.parse(env.WHATNOT_CATEGORY_IDS) : {}; } catch { override = {}; }
  // For other games the setting is only the fallback, after matching the game's name.
  if (game !== 'other' && override[game] != null && override[game] !== '') {
    const id = String(override[game]);
    return { id, label: BY_ID.get(Number(id))?.label || null, attrs: BY_ID.get(Number(id))?.attrs || {} };
  }
  let c = null;
  if (GAME_CATEGORY_TYPES[game]) c = BY_TYPE.get(GAME_CATEGORY_TYPES[game]);
  else if (game === 'other') {
    c = categoryForGameName(card?.extraction?.game_name) || null;
    if (!c && override.other) return { id: String(override.other), label: BY_ID.get(Number(override.other))?.label || null, attrs: BY_ID.get(Number(override.other))?.attrs || {} };
    c ||= BY_TYPE.get(OTHER_CATEGORY_TYPE);
  }
  return c ? { id: String(c.id), label: c.label, attrs: c.attrs } : null;
}

export const categoryIdFor = (game, env, gameName = null) => categoryFor({ game, extraction: { game_name: gameName } }, env)?.id || null;

// Snap condition -> Whatnot's condition words (attribute tcg.condition).
export const WHATNOT_CONDITION = { NM: 'Near Mint', LP: 'Light Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Damaged' };
// Grader as printed on the slab -> what Whatnot calls it.
const GRADERS = [[/^psa\b|professional sports/i, 'PSA'], [/^(bgs|beckett)\b/i, 'BECKETT'], [/^cgc\b|certified guaranty/i, 'CGC'], [/^sgc\b/i, 'SGC'], [/^tag\b/i, 'TAG'], [/^ars\b/i, 'ARS']];

const clean = (v) => (v == null ? '' : String(v).trim());
const same = (a, b) => a.toLowerCase().replace(/\s+/g, ' ') === b.toLowerCase().replace(/\s+/g, ' ');

// A value this detail will take, or null. Free-text details use Whatnot's spelling when it lists one.
export function validValue(attrId, value) {
  const a = TCG_ATTRIBUTES[attrId];
  const v = clean(value);
  if (!a || !v) return null;
  if (a.type === 'BOOLEAN') return v === 'true' || v === 'false' ? v : null;
  const listed = (a.values || []).find((x) => same(x, v));
  if (listed) return listed;
  return a.type === 'STRING' && a.custom ? v.slice(0, 255) : null;
}

function graderValue(attrId, grader) {
  const g = clean(grader);
  if (!g) return null;
  const code = GRADERS.find(([re]) => re.test(g))?.[1];
  const a = TCG_ATTRIBUTES[attrId];
  // Some games spell it out: "Professional Sports Authenticator (PSA)", "Beckett Grading Services (BGS)".
  const spelled = code && (a?.values || []).find((x) => x === code || x.includes(`(${code === 'BECKETT' ? 'BGS' : code})`));
  return validValue(attrId, spelled || code || g);
}

function languageValue(attrId, language) {
  const lang = clean(language) || 'English';
  const a = TCG_ATTRIBUTES[attrId];
  if ((a?.values || []).includes('Non-English')) return /^english$/i.test(lang) ? 'English' : 'Non-English';
  return validValue(attrId, lang);
}

// The single-card choice in a category's "Product Type" list ("Card", "Single Card", "Singles").
function singleCardValue(attrId) {
  return (TCG_ATTRIBUTES[attrId]?.values || []).find((v) => /^(single card|singles|card)$/i.test(v)) || null;
}

// The `attributes` for POST /products: [{ id, value }], ids as strings like the API takes them.
export function productAttributes(card, category) {
  const attrs = category?.attrs || {};
  const x = card?.extraction || {};
  const graded = !!(card?.graded ?? x.graded);
  const want = {
    condition: graded ? 'Graded' : WHATNOT_CONDITION[card?.condition] || WHATNOT_CONDITION.NM,
    product_type: attrs.product_type ? singleCardValue(attrs.product_type) : null,
    set: card?.catalog_set || card?.set_name || x.set_name,
    card_number: card?.catalog_number || card?.collector_number || x.collector_number,
    language: attrs.language ? languageValue(attrs.language, card?.language || x.language) : null,
    rarity: card?.rarity || x.rarity,
    // CONFIRM: the spec types every attribute value as a string; "true" for a BOOLEAN detail is our reading.
    graded: graded ? 'true' : null,
    grading_service: graded && attrs.grading_service ? graderValue(attrs.grading_service, card?.grader || x.grader) : null,
    grade: graded ? card?.grade || x.grade : null,
    cert: graded ? card?.cert_number || x.cert_number : null,
  };
  const out = [];
  for (const [role, attrId] of Object.entries(attrs)) {
    const value = ['language', 'grading_service', 'product_type'].includes(role) ? want[role] : validValue(attrId, want[role]);
    if (value) out.push({ id: String(attrId), value });
  }
  return out;
}
