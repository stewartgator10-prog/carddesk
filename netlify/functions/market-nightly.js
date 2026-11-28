// netlify/functions/market-nightly.js
// Nightly at 08:17 UTC (3:17 AM Eastern in winter, 4:17 AM in summer): starts the market refresh
// for every connected seller. Scheduled functions may only run 30 s, so this hands the work to the
// background function (up to 15 minutes) with a signed request.
import { signCron } from '../lib/cron-signature.js';

export default async () => {
  // Both sites share one database, so only one of them should run the nightly refresh for everyone.
  // NIGHTLY_REFRESH=off on the other site.
  if (process.env.NIGHTLY_REFRESH === 'off') { console.info('market-nightly: off on this site'); return; }
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) { console.error('market-nightly: no site URL'); return; }
  const { ts, sig } = signCron();
  const res = await fetch(`${base}/api/market-refresh-run`, { method: 'POST', headers: { 'x-cd-ts': ts, 'x-cd-sig': sig } });
  console.info('market-nightly: started background refresh', res.status);
};

export const config = { schedule: '17 8 * * *' };
