// netlify/lib/card-vision.js
// Reads a trading card from a photo with Claude and returns a structured result.
// Same prompt and schema for every model, so the model trial is a fair comparison.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const SNAP_MODELS = ['claude-opus-5-5', 'claude-haiku-5-5'];
export const DEFAULT_SNAP_MODEL = 'claude-opus-5-5';

export const CardRead = z.object({
  is_trading_card: z.boolean(),
  game: z.enum(['pokemon', 'mtg', 'one_piece', 'lorcana', 'yugioh', 'sports', 'other']),
  card_name: z.string(),
  collector_number: z.string().nullable(),
  set_name: z.string().nullable(),
  set_code: z.string().nullable(),
  language: z.string(),
  finish: z.enum(['normal', 'holo', 'reverse_holo', 'foil', 'unknown']),
  variant: z.string().nullable(),
  graded: z.boolean(),
  condition_guess: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG', 'unknown']),
  possible_misprint: z.boolean(),
  misprint_notes: z.string().nullable(),
  confidence: z.number(),
  notes: z.string().nullable(),
});

export const SYSTEM_PROMPT = `You identify trading cards from photos for a card seller who lists them on eBay.
Report only what you can read or clearly see. Never invent a value: use null when it isn't visible.

- card_name: the name exactly as printed, including suffixes such as "ex", "V", "VMAX", "GX" and prefixes such as "Hisuian" or "Radiant".
- collector_number: exactly as printed, keeping leading zeros and the set total, for example "035/193", "TG05/TG30", "SWSH050" or "216". Pokémon prints it bottom left or bottom right; Magic prints it bottom left above the set code.
- set_code: the printed set code if there is one (Magic: three or four letters bottom left such as "SPM" or "W17"; Pokémon: the small regulation/set code if legible). set_name only if you are sure which set it is.
- language: the card's language in English, for example "English" or "Japanese".
- finish: "reverse_holo" when the foil pattern covers the card body but not the artwork; "holo" when the artwork itself is foil; "foil" for a foil Magic card; "normal" when nothing is foil; "unknown" when the photo can't show it.
- variant: printed variations that change value, for example "Poke Ball Pattern", "Master Ball Pattern", "Borderless", "Showcase", "Extended Art", "1st Edition", "Shadowless", "Promo". Otherwise null.
- graded: true if the card is inside a grading slab.
- condition_guess: only from visible wear; "unknown" if the photo can't show the edges and surface.
- possible_misprint: true only for visible evidence such as texture shift, print grid lines, a crimp, ink smear or missing ink, a miscut, or heavy off-centering. Describe what you see in misprint_notes. Do not flag ordinary holo patterns or photo glare.
- confidence: from 0 to 1, how sure you are that card_name and collector_number are both right.
- notes: anything a seller should check by hand, otherwise null.`;

let client = null;
function getClient() {
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

export function buildRequest(model, image) {
  const params = {
    model,
    max_tokens: 8000,
    output_config: { effort: 'low', format: betaZodOutputFormat(CardRead) },
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: 'Identify this card.' },
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
export function parseCardRead(msg) {
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const out = CardRead.safeParse(JSON.parse(text));
    return out.success ? out.data : null;
  } catch {
    return null;
  }
}

// image: { base64, mediaType }. Returns { read, usage, servedModel, requestId, latencyMs }.
// Throws an Error carrying .usage/.requestId when a response came back but couldn't be used,
// so the caller can still log what it cost.
export async function readCard({ model, image, anthropic = null }) {
  if (!SNAP_MODELS.includes(model)) throw new Error(`Unsupported model ${model}`);
  const api = anthropic || getClient();
  const t0 = Date.now();
  // create().withResponse() (not parse()) so the request id survives for the fee log.
  const { data: msg, request_id } = await api.beta.messages.create(buildRequest(model, image)).withResponse();
  const latencyMs = Date.now() - t0;
  const base = { usage: msg.usage, servedModel: msg.model || model, requestId: request_id, latencyMs };
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to read this photo.'), base);
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('Claude ran out of room before finishing.'), base);
  const read = parseCardRead(msg);
  if (!read) throw Object.assign(new Error('Claude returned an unreadable answer.'), base);
  return { read, ...base };
}

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
