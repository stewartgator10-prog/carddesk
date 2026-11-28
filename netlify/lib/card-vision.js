// netlify/lib/card-vision.js
// Reads a trading card from a photo with Claude and returns a structured result.
// Same prompt and schema for every model, so the model trial is a fair comparison.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const SNAP_MODELS = ['claude-opus-5-5', 'claude-haiku-5-5'];
export const DEFAULT_SNAP_MODEL = 'claude-opus-5-5';

// The card's four corners as fractions of the photo (0 = left/top edge, 1 = right/bottom edge).
const Pt = z.object({ x: z.number(), y: z.number() });
export const Corners = z.object({ tl: Pt, tr: Pt, br: Pt, bl: Pt });

export const CardRead = z.object({
  is_trading_card: z.boolean(),
  game: z.enum(['pokemon', 'mtg', 'one_piece', 'lorcana', 'yugioh', 'sports', 'other']),
  card_name: z.string(),
  printed_name: z.string().nullable(),
  collector_number: z.string().nullable(),
  set_name: z.string().nullable(),
  set_code: z.string().nullable(),
  language: z.string(),
  finish: z.enum(['normal', 'holo', 'reverse_holo', 'foil', 'unknown']),
  variant: z.string().nullable(),
  rarity: z.string().nullable(),
  game_name: z.string().nullable(),
  art_description: z.string().nullable(),
  flavor_text: z.string().nullable(),
  condition_notes: z.string().nullable(),
  graded: z.boolean(),
  grader: z.string().nullable(),
  grade: z.string().nullable(),
  condition_guess: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG', 'unknown']),
  possible_misprint: z.boolean(),
  misprint_notes: z.string().nullable(),
  confidence: z.number(),
  notes: z.string().nullable(),
  card_corners: Corners.nullable(),
});

const CORNERS_RULE = `- card_corners: where the card's four corners are in the photo, as fractions of the photo's width (x) and height (y), 0 to 1, measured from the top-left of the photo as you see it: tl, tr, br, bl are the card's own top-left, top-right, bottom-right and bottom-left as the card is printed (if the card is upside down or sideways in the photo, tl is still the corner at the top-left of the card's artwork). For a rounded corner, give the point where the two straight edges would meet. For a card in a grading slab, give the corners of the slab's outer edge. Be as exact as you can. Null if any corner is outside the photo or hidden.`;

export const SYSTEM_PROMPT = `You identify trading cards from photos for a card seller who lists them on eBay.
Report only what you can read or clearly see. Never invent a value: use null when it isn't visible.

- card_name: the card's name in English, including suffixes such as "ex", "V", "VMAX", "GX" and prefixes such as "Hisuian" or "Radiant". For a card printed in another language (Japanese, Chinese, Korean and so on), give its official English name, for example "Electivire ex" for エレキブルex or "Professor's Research" for 博士の研究. Never put non-English characters in card_name. If you don't know the English name, give your best English reading and lower confidence.
- printed_name: for a card not printed in English, the name exactly as printed in its own language; otherwise null.
- collector_number: exactly as printed, keeping leading zeros and the set total, for example "035/193", "TG05/TG30", "SWSH050" or "216". Pokémon prints it bottom left or bottom right; Magic prints it bottom left above the set code.
- set_code: the printed set code if there is one (Magic: three or four letters bottom left such as "SPM" or "W17"; Pokémon: the small regulation/set code if legible). set_name only if you are sure which set it is.
- game: "yugioh" for Yu-Gi-Oh!, "one_piece" for the One Piece Card Game, "lorcana" for Disney Lorcana, "sports" for sports cards, "other" for any other card game.
- game_name: only when game is "other": the game's name as printed or as you recognise it, for example "Digimon Card Game", "Dragon Ball Super Card Game", "Flesh and Blood", "Weiss Schwarz". Otherwise null.
- Yu-Gi-Oh!: collector_number is the set code printed under the right side of the artwork, for example "LOB-EN001" or "RA01-EN008"; set_code is the part before the dash. Put "1st Edition" or "Limited Edition" in variant when it is printed under the left side of the artwork.
- One Piece: collector_number is the card number printed bottom right, for example "OP01-001", "ST01-001", "EB01-006" or "P-001". Put "Alternate Art", "Manga", "SP" or "Treasure Cup" in variant when the artwork or foil is not the standard version.
- Lorcana: card_name is the name and the version line joined with " - ", for example "Elsa - Snow Queen". collector_number is the number printed bottom left, for example "53/204", and set_code is the set number or code printed after the language there, for example "9". Use finish "foil" for a foil card and put "Enchanted" in variant for an Enchanted card.
- rarity: as printed or as the foil shows it, otherwise null. Yu-Gi-Oh!: "Common", "Rare" (silver name), "Super Rare" (foil artwork), "Ultra Rare" (gold foil name and foil artwork), "Secret Rare", "Quarter Century Secret Rare" and so on. One Piece: the printed letters such as "C", "UC", "R", "SR", "SEC", "L". Lorcana: the symbol's name such as "Common", "Rare", "Super Rare", "Legendary", "Enchanted".
- language: the card's language in English, for example "English" or "Japanese".
- finish: "reverse_holo" when the foil pattern covers the card body but not the artwork; "holo" when the artwork itself is foil; "foil" for a foil Magic card; "normal" when nothing is foil; "unknown" when the photo can't show it.
- variant: printed variations that change value, for example "Poke Ball Pattern", "Master Ball Pattern", "Borderless", "Showcase", "Extended Art", "1st Edition", "Shadowless", "Promo". Otherwise null.
- graded: true if the card is inside a grading slab. grader and grade: as printed on the slab label, for example "PSA" and "8", or "BGS" and "9.5"; otherwise null.
- art_description: one or two plain sentences on what the artwork shows: what is pictured, what it is doing, the main colors and the art style. Only what you can see; do not name characters, places or abilities unless they are printed on the card. Null if the artwork isn't visible.
- flavor_text: the card's flavor text (usually italic, separate from game rules and attacks) exactly as printed, only if you can read all of it. Never game rules, attacks or abilities. Otherwise null.
- condition_notes: visible wear in a few plain words, for example "light whitening on the back corners" or "a scratch across the artwork". Null if none is visible or the photo can't show it.
- condition_guess: only from visible wear; "unknown" if the photo can't show the edges and surface.
- possible_misprint: true only for visible evidence such as texture shift, print grid lines, a crimp, ink smear or missing ink, a miscut, or heavy off-centering. Describe what you see in misprint_notes. Do not flag ordinary holo patterns or photo glare.
- confidence: from 0 to 1, how sure you are that card_name and collector_number are both right.
- notes: anything a seller should check by hand, otherwise null.
${CORNERS_RULE}`;

let client = null;
export function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      const e = new Error('ANTHROPIC_API_KEY is not set in Netlify environment variables.');
      e.code = 'NO_API_KEY';
      throw e;
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 });
  }
  return client;
}

export function buildRequest(model, image, { schema = CardRead, system = SYSTEM_PROMPT, prompt = 'Identify this card.' } = {}) {
  const params = {
    model,
    max_tokens: 8000,
    output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
    system,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: prompt },
      ],
    }],
  };
  // Same beta flag the SDK's own parse() helper sends for structured outputs on the beta endpoint.
  params.betas = ['structured-outputs-2025-12-15'];
  // If Opus declines a request on a safety check, the API retries it on a fallback model in the same call.
  if (model === 'claude-opus-5-5') {
    params.betas.push('server-side-fallback-2026-07-01');
    params.fallbacks = 'default';
  }
  return params;
}

// The answer is the JSON text block; validate it against the same schema the request sent.
export function parseCardRead(msg, schema = CardRead) {
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const out = schema.safeParse(JSON.parse(text));
    return out.success ? out.data : null;
  } catch {
    return null;
  }
}

// image: { base64, mediaType }. Returns { read, usage, servedModel, requestId, latencyMs }.
// Throws an Error carrying .usage/.requestId when a response came back but couldn't be used,
// so the caller can still log what it cost.
export async function readCard({ model, image, anthropic = null, schema = CardRead, system = SYSTEM_PROMPT, prompt = 'Identify this card.' }) {
  if (!SNAP_MODELS.includes(model)) throw new Error(`Unsupported model ${model}`);
  const api = anthropic || getClient();
  const t0 = Date.now();
  // create().withResponse() (not parse()) so the request id survives for the fee log.
  const { data: msg, request_id } = await api.beta.messages.create(buildRequest(model, image, { schema, system, prompt })).withResponse();
  const latencyMs = Date.now() - t0;
  const base = { usage: msg.usage, servedModel: msg.model || model, requestId: request_id, latencyMs };
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to read this photo.'), base);
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('Claude ran out of room before finishing.'), base);
  const read = parseCardRead(msg, schema);
  if (!read) throw Object.assign(new Error('Claude returned an unreadable answer.'), base);
  return { read, ...base };
}

// Just the corners, for photos added after the snap (the back, a second angle).
export const CornersRead = z.object({ card_found: z.boolean(), graded: z.boolean(), card_corners: Corners.nullable() });
export const CORNERS_PROMPT = `You find a trading card in a photo so it can be straightened and cropped for an eBay listing.
- card_found: true only if one whole card (front or back) is in the photo with all four corners visible. False for close-ups of part of a card, several cards, or no card.
- graded: true if the card is inside a grading slab.
${CORNERS_RULE.replace('For a card in a grading slab', 'For a slab')}
  For the back of a card, tl is whichever corner is at the top-left when the card is upright.`;
export const readCorners = ({ model, image, anthropic = null }) =>
  readCard({ model, image, anthropic, schema: CornersRead, system: CORNERS_PROMPT, prompt: 'Find the card\'s corners.' });

// Downloads an image (eBay listing photo) and returns { base64, mediaType }.
export async function fetchImage(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { Accept: 'image/jpeg,image/png,image/webp;q=0.9' } });
  if (!res.ok) throw new Error(`Photo download failed (${res.status})`);
  const mediaType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) throw new Error(`Unsupported photo type ${mediaType}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5 * 1024 * 1024) throw new Error('Photo is over 5 MB');
  return { base64: buf.toString('base64'), mediaType };
}

// ---------- several cards in one photo (binder page or a spread), for buy offers ----------
export const PAGE_PROMPT = `${SYSTEM_PROMPT.replace(`\n${CORNERS_RULE}`, '')}

This photo may show several cards: a binder page or cards laid out on a table. Return every trading card you can see, at most 9, in reading order (left to right, then top to bottom) with position starting at 1. For each card give box: where the card is in the photo as fractions of the photo's width and height (x, y = top-left corner; w, h = width and height), each between 0 and 1. If a card's small print can't be read, still return it with your best name and a low confidence.`;

export const PageRead = z.object({
  cards: z.array(CardRead.omit({ card_corners: true }).extend({
    position: z.number().int(),
    box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  })),
});

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));
export const cleanBox = (b) => {
  const x = clamp01(b?.x), y = clamp01(b?.y);
  return { x, y, w: Math.min(clamp01(b?.w), 1 - x), h: Math.min(clamp01(b?.h), 1 - y) };
};

export async function readPage({ model, image, anthropic = null }) {
  if (!SNAP_MODELS.includes(model)) throw new Error(`Unsupported model ${model}`);
  const api = anthropic || getClient();
  const t0 = Date.now();
  const req = buildRequest(model, image, { schema: PageRead, system: PAGE_PROMPT, prompt: 'Identify every card in this photo.' });
  const { data: msg, request_id } = await api.beta.messages.create(req).withResponse();
  const base = { usage: msg.usage, servedModel: msg.model || model, requestId: request_id, latencyMs: Date.now() - t0 };
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to read this photo.'), base);
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('Claude ran out of room before finishing.'), base);
  const page = parseCardRead(msg, PageRead);
  if (!page) throw Object.assign(new Error('Claude returned an unreadable answer.'), base);
  const cards = page.cards.slice(0, 9).map((c, i) => ({ ...c, position: i + 1, box: cleanBox(c.box) }));
  return { cards, ...base };
}
