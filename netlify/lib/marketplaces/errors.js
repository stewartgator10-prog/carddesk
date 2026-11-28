// netlify/lib/marketplaces/errors.js
// One error type for every marketplace adapter. `sellerMessage` is safe to show the seller and to
// store; it never contains a token. Codes:
//   reconnect      the token stopped working (401 / expired): paste a new one
//   missing_scope  the token can't do this (403)
//   rate_limited   the marketplace asked us to slow down and retries ran out
//   not_found      the listing or product is gone
//   rejected       the marketplace refused the request (400/409/422), with its own reason
//   unavailable    5xx, timeout or no connection
//   not_set_up     this site or this seller can't use the marketplace yet
export const CODES = ['reconnect', 'missing_scope', 'rate_limited', 'not_found', 'rejected', 'unavailable', 'not_set_up'];

export class MarketplaceError extends Error {
  constructor(code, sellerMessage, { status = null, detail = null } = {}) {
    super(sellerMessage);
    this.name = 'MarketplaceError';
    this.code = code;
    this.sellerMessage = sellerMessage;
    this.status = status;
    this.detail = detail;
  }
}

export const isMarketplaceError = (e) => e instanceof MarketplaceError;

// HTTP status to send our own browser for an adapter error.
export function httpStatusFor(err) {
  if (!isMarketplaceError(err)) return 500;
  return { reconnect: 409, missing_scope: 409, rate_limited: 429, not_found: 404, rejected: 422, unavailable: 502, not_set_up: 503 }[err.code] || 500;
}
