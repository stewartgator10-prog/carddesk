// netlify/lib/ai-usage.js
// API fee tracker: what each Claude call cost, and the monthly budget guard.
//
// Costs are ESTIMATES from Anthropic's published per-token list prices (USD per million
// tokens, checked Nov 2026). They track Anthropic's invoice closely but aren't the invoice:
// taxes, credits and price changes only show up there. Update MODEL_PRICES if prices change.

export const MODEL_PRICES = {
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export const MODEL_LABELS = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
};

export const DEFAULT_MONTHLY_BUDGET = 25; // USD; the seller can change it in Snap settings

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// usage: the Messages API `usage` object (input_tokens, output_tokens, cache_*_input_tokens).
export function costOf(model, usage = {}) {
  const p = MODEL_PRICES[model];
  if (!p) return null; // unknown model: logged with tokens, cost left for a human to check
  const usd = (n(usage.input_tokens) * p.input
    + n(usage.output_tokens) * p.output
    + n(usage.cache_read_input_tokens) * p.cacheRead
    + n(usage.cache_creation_input_tokens) * p.cacheWrite) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

export function usageRow({ userId, model, purpose, usage, latencyMs, requestId, snapItemId = null, ok = true, error = null }) {
  return {
    user_id: userId,
    provider: 'anthropic',
    model,
    purpose,
    snap_item_id: snapItemId,
    input_tokens: n(usage?.input_tokens),
    output_tokens: n(usage?.output_tokens),
    cache_read_tokens: n(usage?.cache_read_input_tokens),
    cache_write_tokens: n(usage?.cache_creation_input_tokens),
    cost_usd: costOf(model, usage) ?? 0,
    latency_ms: latencyMs ?? null,
    ok,
    error: error ? String(error).slice(0, 500) : null,
    request_id: requestId || null,
  };
}

export async function logUsage(db, row) {
  const { error } = await db.from('api_usage').insert(row);
  if (error) console.error('api_usage insert failed', error.message);
}

export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// Refuses new AI calls once this calendar month's estimated spend reaches the budget.
export async function checkBudget(db, userId, settings = {}, now = new Date()) {
  const budget = Number.isFinite(Number(settings.aiMonthlyBudget)) && settings.aiMonthlyBudget !== ''
    ? Number(settings.aiMonthlyBudget) : DEFAULT_MONTHLY_BUDGET;
  const { data, error } = await db.from('api_usage').select('cost_usd')
    .eq('user_id', userId).gte('created_at', monthStart(now));
  if (error) throw new Error(error.message);
  const spent = (data || []).reduce((s, r) => s + n(r.cost_usd), 0);
  return { spent: Math.round(spent * 100) / 100, budget, ok: budget <= 0 ? true : spent < budget };
}
