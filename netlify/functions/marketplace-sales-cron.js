// netlify/functions/marketplace-sales-cron.js
// Every 5 minutes: starts the sale check ("sell once") for every seller with Whatnot connected or a
// card on two marketplaces. Scheduled functions may only run 30 s, so this hands the work to the
// background function with a signed request.
import { signCron } from '../lib/cron-signature.js';

export default async () => {
  // Both sites share one database, so only one runs it. SALES_CHECK=off on the other (Tyche Cards).
  if (process.env.SALES_CHECK === 'off') { console.info('marketplace-sales-cron: off on this site'); return; }
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) { console.error('marketplace-sales-cron: no site URL'); return; }
  const { ts, sig } = signCron(Date.now(), 'sales-check');
  const res = await fetch(`${base}/api/marketplace-sales-run`, { method: 'POST', headers: { 'x-cd-ts': ts, 'x-cd-sig': sig } });
  console.info('marketplace-sales-cron: started', res.status);
};

export const config = { schedule: '*/5 * * * *' };
