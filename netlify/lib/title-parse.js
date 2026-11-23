// netlify/lib/title-parse.js
// Reads eBay listing titles into card details with Claude, 25 titles per call.
// Used once per listing by automatic comps (results are cached in listing_market).
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { getClient } from './card-vision.js';

export const TITLE_MODEL = 'claude-haiku-5-5';
export const TITLES_PER_CALL = 25;

const TitleItem = z.object({
  i: z.number().int(),
  is_single_card: z.boolean(),
  game: z.enum(['pokemon', 'mtg', 'one_piece', 'lorcana', 'yugioh', 'sports', 'other']),
  card_name: z.string(),
  collector_number: z.string().nullable(),
  set_name: z.string().nullable(),
  set_code: z.string().nullable(),
  language: z.string(),
  finish: z.enum(['normal', 'holo', 'reverse_holo', 'foil', 'unknown']),
  variant: z.string().nullable(),
  graded: z.boolean(),
  grader: z.string().nullable(),
  grade: z.string().nullable(),
  condition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG', 'unknown']),
});
export const TitleBatch = z.object({ items: z.array(TitleItem) });

export const TITLE_PROMPT = `You read trading card eBay listing titles and return the card they describe, one result per numbered title.
Use only what the title says; null when it doesn't say.
- is_single_card: false for lots, sealed product, books, stickers, merchandise, bundles.
- game: Magic cards include Universes Beyond sets such as "Marvel's Spider-Man" or "Final Fantasy". "pokemon" for Pokémon.
- card_name: the card's printed name only (e.g. "Hisuian Goodra V", "Spider-Man 2099", "Lizard, Connors's Curse"), without set, number, rarity, condition, misprint or seller words.
- collector_number: exactly as written, keeping leading zeros and the total, e.g. "035/193", "0101/07", "216", "OP07-118".
- set_name / set_code: as written (e.g. "Paldea Evolved", "sv2a", "M4: Ninja Spinner"); strip prefixes like "Sv:" only if clearly not part of the name.
- language: "English" unless the title says another (Japanese, Chinese, Korean...).
- finish: "reverse_holo" for "Reverse Holo"; "holo" for Holo; "foil" for Magic foil/FOIL; "normal" for "Regular" or nothing said; "unknown" if unclear.
- variant: value-changing extras such as "Poke Ball Pattern", "Borderless", "Extended Art", "Art Card", "Stamp", "Promo", "Misprint: texture shift".
- graded/grader/grade: only for slabs (PSA 10, BGS 9.5, CGC 9...).
- condition: NM/LP/MP/HP/DMG if written, else "unknown".`;

// titles: [{ i, title }] -> { reads: Map(i -> read), usage, requestId, latencyMs }
export async function parseTitles({ titles, model = TITLE_MODEL, anthropic = null }) {
  if (!titles.length) return { reads: new Map(), usage: null };
  const api = anthropic || getClient();
  const t0 = Date.now();
  const list = titles.map((t) => `${t.i}. ${String(t.title).replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
  const { data: msg, request_id } = await api.beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: 'low', format: betaZodOutputFormat(TitleBatch) },
    betas: ['structured-outputs-2025-12-15'],
    system: TITLE_PROMPT,
    messages: [{ role: 'user', content: `Titles:\n${list}` }],
  }).withResponse();
  const base = { usage: msg.usage, requestId: request_id, latencyMs: Date.now() - t0 };
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw Object.assign(new Error(`Title reading stopped (${msg.stop_reason}).`), base);
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed = null;
  try { const r = TitleBatch.safeParse(JSON.parse(text)); parsed = r.success ? r.data : null; } catch { parsed = null; }
  if (!parsed) throw Object.assign(new Error('Title reading returned an unreadable answer.'), base);
  const wanted = new Set(titles.map((t) => t.i));
  return { reads: new Map(parsed.items.filter((x) => wanted.has(x.i)).map((x) => [x.i, x])), ...base };
}
