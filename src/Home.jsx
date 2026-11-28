import React, { useEffect, useState } from 'react';
import '@fontsource/marcellus/400.css';
import '@fontsource-variable/inter';
import './home.css';
import { supabase, supabaseConfigured } from './lib/supabase.js';
import { TycheEmblem } from './brand.jsx';
import { PLANS, PLAN_ORDER } from '../netlify/lib/plans.js';

// The public Tyche Cards site: homepage with pricing, and the terms and privacy pages.
export default function Home() {
  const path = window.location.pathname;
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    if (supabaseConfigured) supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
    if (path === '/pricing') document.getElementById('pricing')?.scrollIntoView();
  }, [path]);
  const page = path.startsWith('/legal/terms') ? <Terms /> : path.startsWith('/legal/privacy') ? <Privacy /> : <Landing />;
  return (
    <div className="ty">
      <Nav signedIn={signedIn} />
      {page}
      <Footer />
    </div>
  );
}

function Nav({ signedIn }) {
  return (
    <header className="ty-nav">
      <div className="ty-wrap ty-nav-row">
        <a href="/" className="ty-brand" aria-label="Tyche Cards home"><TycheEmblem height={42} alt="" /><span>Tyche Cards</span></a>
        <nav className="ty-links" aria-label="Main">
          <a href="/#features">Features</a>
          <a href="/#pricing">Pricing</a>
          {signedIn
            ? <a className="ty-btn ty-btn-gold ty-btn-sm" href="/app">Open the app</a>
            : <><a href="/app">Sign in</a><a className="ty-btn ty-btn-gold ty-btn-sm" href="/app?signup=1">Start free</a></>}
        </nav>
      </div>
    </header>
  );
}

function Wheel() {
  return (
    <svg className="ty-wheel" viewBox="0 0 200 200" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.2">
        <circle cx="100" cy="100" r="96" /><circle cx="100" cy="100" r="80" /><circle cx="100" cy="100" r="18" />
        {Array.from({ length: 16 }, (_, i) => { const a = (i * Math.PI) / 8; return <line key={i} x1={100 + Math.cos(a) * 18} y1={100 + Math.sin(a) * 18} x2={100 + Math.cos(a) * 96} y2={100 + Math.sin(a) * 96} />; })}
        {Array.from({ length: 48 }, (_, i) => { const a = (i * Math.PI) / 24; return <line key={`t${i}`} x1={100 + Math.cos(a) * 88} y1={100 + Math.sin(a) * 88} x2={100 + Math.cos(a) * 92} y2={100 + Math.sin(a) * 92} />; })}
      </g>
    </svg>
  );
}

// Three cards fanned out, each showing a step the app does for real.
function CardFan() {
  const cards = [
    { k: 'Identified', l1: 'Name, number and set', l2: 'from one photo', tone: 'a' },
    { k: 'Priced', l1: '$4.89', l2: 'market $4.20 · TCGplayer', tone: 'b' },
    { k: 'Listed', l1: 'Live on eBay', l2: 'Best Offer on · promoted 2%', tone: 'c' },
  ];
  return (
    <div className="ty-fan" aria-hidden="true">
      {cards.map((c, i) => (
        <div key={c.k} className={`ty-card ty-card-${i}`}>
          <div className={`ty-card-art ty-art-${c.tone}`} />
          <div className="ty-card-chip">{c.k}</div>
          <div className="ty-card-l1">{c.l1}</div>
          <div className="ty-card-l2">{c.l2}</div>
        </div>
      ))}
    </div>
  );
}

const FEATURES = [
  ['Identify any card from a photo', 'Pokémon, Magic, Yu-Gi-Oh!, One Piece, Lorcana and more, including Japanese cards. The AI reads the name, number, set, rarity and finish, and flags possible misprints.'],
  ['Priced from the market', 'Matched to TCGplayer prices through each game\'s catalog, or to recent eBay sales when there\'s no catalog price. Your markup, minimum and price ending are applied for you.'],
  ['Photos that sell', 'Every snap is straightened and cropped so the card fills the frame, with clean white around the corners. The card itself is never retouched, and you can undo any edit.'],
  ['Titles and descriptions written for eBay', '70 to 80 character titles that lead with the card name and number, and a plain-English description of the card.'],
  ['A repricer that watches the market', 'Compare every live listing with market prices and competing listings, change prices in bulk and turn Best Offer on or off.'],
  ['Collection tracking with sell alerts', 'Scan your personal collection, watch its value every night and get an alert when a card hits your target price or growth.'],
  ['Buy offers from a binder photo', 'Snap a page of someone\'s cards and get a fair offer for each one, in seconds, at the counter or at a show.'],
  ['Profit on every card', 'Costs, eBay fees and sales matched automatically, so you know what each card actually made you.'],
];

const FAQ = [
  ['Do I need an eBay account?', 'Yes, a seller account. You connect it once and Tyche Cards lists for you using your own shipping and return policies.'],
  ['What counts as a card?', 'Each card the AI reads: a snap you list, or a card you scan into your collection. Editing, repricing and relisting don\'t count. Your count resets on the 1st of each month.'],
  ['Which games does it support?', 'Pokémon (English and Japanese), Magic: The Gathering, Yu-Gi-Oh!, One Piece, Disney Lorcana and other card games priced from eBay sales. Sports cards are coming.'],
  ['Can I change plans or cancel?', 'Any time, from Plan & billing in the app. Upgrades start right away; cancelling keeps your plan until the end of the period you paid for.'],
  ['Is my data private?', 'Your cards, prices and sales are yours. We never sell your data, and your eBay connection only does what you ask it to.'],
  ['Are AI costs included?', 'Yes. Every plan includes the AI for its monthly card count. There\'s nothing extra to pay.'],
];

function Landing() {
  const [yearly, setYearly] = useState(false);
  return (
    <main>
      <section className="ty-hero">
        <Wheel />
        <div className="ty-wrap ty-hero-grid">
          <div className="ty-hero-copy">
            <div className="ty-eyebrow">For trading card sellers</div>
            <h1>Fortune favors the listed.</h1>
            <p className="ty-lede">Snap a stack of cards. Tyche Cards identifies each one, prices it from the market, cleans up the photo and lists it on eBay. Then it keeps your prices sharp and shows the profit on every card.</p>
            <div className="ty-ctas">
              <a className="ty-btn ty-btn-gold" href="/app?signup=1">Start free</a>
              <a className="ty-btn ty-btn-ghost" href="#pricing">See pricing</a>
            </div>
            <div className="ty-fine">25 cards a month free. No credit card needed.</div>
          </div>
          <CardFan />
        </div>
      </section>

      <section className="ty-section">
        <div className="ty-wrap">
          <h2>From pull to paid in three steps</h2>
          <ol className="ty-steps">
            <li><b>Snap</b><span>Photograph your cards, one per photo, straight from your phone's camera roll.</span></li>
            <li><b>Check</b><span>Each card comes back identified, priced, titled and photographed. Fix anything in a tap.</span></li>
            <li><b>Publish</b><span>Run eBay's free listing check, then publish them all with your own policies.</span></li>
          </ol>
        </div>
      </section>

      <section className="ty-section ty-marble" id="features">
        <div className="ty-wrap">
          <h2>Everything on the selling side, in one place</h2>
          <p className="ty-sub">Other tools scan, or price, or track. Tyche Cards runs the whole loop: buy, snap, list, reprice, sell, and see the profit.</p>
          <div className="ty-features">
            {FEATURES.map(([t, d]) => <div key={t} className="ty-feature"><h3>{t}</h3><p>{d}</p></div>)}
          </div>
          <div className="ty-ai">
            <TycheEmblem height={52} alt="" />
            <div><h3>Works with your AI assistant</h3><p>Connect Claude, Muse or another AI app and run your store by chat: "price this stack", "which collection cards should I sell?", "turn Best Offer off on these". Anything that changes eBay asks you first.</p></div>
          </div>
        </div>
      </section>

      <section className="ty-section" id="pricing">
        <div className="ty-wrap">
          <h2>Simple plans, by the cards you list</h2>
          <div className="ty-toggle" role="group" aria-label="Billing period">
            <button className={!yearly ? 'on' : ''} aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
            <button className={yearly ? 'on' : ''} aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly <em>2 months free</em></button>
          </div>
          <div className="ty-plans">
            {PLAN_ORDER.map((id) => {
              const p = PLANS[id];
              const price = yearly ? p.year : p.month;
              const href = id === 'free' ? '/app?signup=1' : `/app?signup=1&plan=${id}&interval=${yearly ? 'year' : 'month'}`;
              return (
                <div key={id} className={`ty-plan ${p.popular ? 'ty-plan-pop' : ''}`}>
                  {p.popular && <div className="ty-pop">Most popular</div>}
                  <h3>{p.name}</h3>
                  <div className="ty-price"><span>${price}</span><small>{id === 'free' ? 'forever' : yearly ? '/ year' : '/ month'}</small></div>
                  <p className="ty-blurb">{p.blurb}</p>
                  <a className={`ty-btn ${p.popular ? 'ty-btn-gold' : 'ty-btn-outline'}`} href={href}>{id === 'free' ? 'Start free' : `Choose ${p.name}`}</a>
                  <ul>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
                </div>
              );
            })}
          </div>
          <p className="ty-fine ty-center">Prices in US dollars. Sales tax may apply. Change or cancel any time.</p>
        </div>
      </section>

      <section className="ty-section ty-founder">
        <div className="ty-wrap ty-founder-row">
          <img className="ty-lockup" src="/brand/tyche-logo-480.webp" width="480" height="569" alt="Tyche Cards: Tyche, goddess of fortune, holding a cornucopia of trading cards. Fortune favors the listed." loading="lazy" />
          <div>
            <h2>Built at a real card table</h2>
            <p>Tyche Cards grew out of a working card business: hundreds of live listings, Japanese misprints, binder buys at shows. Every feature was used on real cards before it reached this page.</p>
            <p>Tyche was the Greek goddess of fortune, usually shown with a crown and a horn of plenty. Card selling has plenty of luck in it. The rest is listing well, pricing right and knowing your numbers, and that's the part we handle.</p>
          </div>
        </div>
      </section>

      <section className="ty-section ty-marble">
        <div className="ty-wrap ty-narrow">
          <h2>Questions</h2>
          <div className="ty-faq">
            {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
        </div>
      </section>

      <section className="ty-cta-band">
        <div className="ty-wrap ty-center">
          <h2>Make your own luck.</h2>
          <p>List your next stack tonight. Your first 25 cards a month are free.</p>
          <a className="ty-btn ty-btn-gold" href="/app?signup=1">Start free</a>
        </div>
      </section>
    </main>
  );
}

function Footer() {
  return (
    <footer className="ty-footer">
      <div className="ty-wrap ty-foot-row">
        <div className="ty-brand ty-brand-sm"><TycheEmblem height={30} alt="" /><span>Tyche Cards</span></div>
        <nav aria-label="Legal"><a href="/legal/terms">Terms</a><a href="/legal/privacy">Privacy</a><a href="https://techboxsolution.com/" target="_blank" rel="noreferrer">Made by TechBox Solutions</a></nav>
        <div className="ty-fine">Not affiliated with eBay, The Pokémon Company, Wizards of the Coast, Konami, Bandai or Disney. Card names are trademarks of their owners.</div>
      </div>
    </footer>
  );
}

function Legal({ title, updated, children }) {
  useEffect(() => { document.title = `${title} · Tyche Cards`; }, [title]);
  return <main className="ty-section"><div className="ty-wrap ty-narrow ty-legal"><h1>{title}</h1><p className="ty-fine">Last updated {updated}</p>{children}</div></main>;
}

function Terms() {
  return (
    <Legal title="Terms of Service" updated="November 28, 2026">
      <p>Tyche Cards is a service of TechBox Solutions ("we"). By creating an account you agree to these terms.</p>
      <h2>Your account</h2>
      <p>You're responsible for your account and for the listings, prices and offers you publish through it. You must be allowed to sell the cards you list, and you must follow eBay's rules and any other marketplace's rules.</p>
      <h2>The AI and your listings</h2>
      <p>The AI identifies, prices and describes cards and edits photos to help you list faster. It can be wrong. Check each card before you publish. Nothing goes live on eBay until you choose to publish or update it.</p>
      <h2>Plans and billing</h2>
      <p>Paid plans renew automatically each month or year until you cancel. Card limits reset on the 1st of each calendar month. Upgrades take effect right away; cancelling keeps your plan until the end of the paid period. Payments are handled by Stripe. Except where the law requires, payments are not refunded for partial periods.</p>
      <h2>Fair use</h2>
      <p>Don't misuse the service: no reselling access, scraping, or attempts to get around plan limits. We may suspend accounts that do.</p>
      <h2>Availability and liability</h2>
      <p>We work to keep the service running but can't promise it will always be available or error-free. To the extent the law allows, our liability is limited to what you paid us in the 12 months before a claim. We aren't liable for marketplace decisions, lost sales or indirect losses.</p>
      <h2>Changes</h2>
      <p>We may update these terms. If a change matters, we'll tell you in the app or by email before it takes effect.</p>
      <h2>Contact</h2>
      <p>Questions: use the contact form at techboxsolution.com.</p>
    </Legal>
  );
}

function Privacy() {
  return (
    <Legal title="Privacy Policy" updated="November 28, 2026">
      <p>This explains what Tyche Cards (a service of TechBox Solutions) collects and why.</p>
      <h2>What we keep</h2>
      <ul>
        <li>Your account email and sign-in details.</li>
        <li>The card photos you upload, the details read from them, your prices, costs, collection and sales records.</li>
        <li>Your eBay connection (an access token, never your eBay password) and the listing and order data it reads.</li>
        <li>Your plan and billing status. Card payment details are handled by Stripe; we never see or store card numbers.</li>
      </ul>
      <h2>How it's used</h2>
      <p>Only to run the service for you: identifying and pricing cards, listing and updating them on eBay at your request, tracking your sales and profit, and billing. Card photos are sent to our AI provider (Anthropic) to be read; they aren't used to train its models.</p>
      <h2>What we never do</h2>
      <p>We don't sell your data or share it for advertising.</p>
      <h2>Where it's stored</h2>
      <p>With our hosting and database providers (Netlify and Supabase), protected so each account only sees its own data.</p>
      <h2>Your choices</h2>
      <p>You can disconnect eBay, export your data, or ask us to delete your account and data at any time through the contact form at techboxsolution.com.</p>
    </Legal>
  );
}
