import React, { useState, useEffect, useMemo, Suspense, lazy, useCallback } from 'react';
import { Search, Plus, Trash2, ExternalLink, Target, Package, BarChart3, Eye, X, Flame, Download, Upload, Link2, Loader, Zap, LogOut, Store, Tag, DollarSign, Camera, Receipt, HandCoins, Settings, Gem, Bell } from 'lucide-react';
import { Hedge, Clouds, useLivingTouches } from './Scenery.jsx';
import EbaySalesTab from './EbaySalesTab.jsx';
import ListingsTab from './ListingsTab.jsx';
import { supabase, apiFetch } from './lib/supabase.js';
import { useCollection, useSettings, importBackup, newId, readLegacyLocalData, markLegacyLocalDataHandled } from './lib/store.js';
import RepricerTab from './pricing/RepricerTab.jsx';
// Loaded only when the tab is opened, so phones don't download it up front.
// Six sections, each holding one or more views. A view keeps its own id, so links such as
// ?tab=listings (the eBay connect redirect) and ?tab=snap still open the right place.
const SECTIONS = [
  { id: 'snap', label: 'Snap to List', Icon: Camera, views: [{ id: 'snap', label: 'Snap to List' }] },
  { id: 'offers', label: 'Buy Offers', Icon: HandCoins, views: [{ id: 'offers', label: 'Buy Offers' }] },
  { id: 'collection', label: 'Collection', Icon: Gem, views: [{ id: 'collection', label: 'Collection' }] },
  { id: 'deals', label: 'Find Deals', Icon: Target, views: [
    { id: 'analyzer', label: 'Deal Analyzer', Icon: Target }, { id: 'livesearch', label: 'Live eBay Search', Icon: Zap },
    { id: 'scanner', label: 'Bulk Scanner', Icon: Search }, { id: 'watchlist', label: 'Watchlist', Icon: Eye },
    { id: 'comps', label: 'Sold Comps', Icon: BarChart3 }] },
  { id: 'prices', label: 'Listings & Prices', Icon: Tag, views: [
    { id: 'repricer', label: 'Repricer', Icon: Tag }, { id: 'listings', label: 'Marketplaces', Icon: Store }] },
  { id: 'stock', label: 'Inventory', Icon: Package, views: [
    { id: 'inventory', label: 'Stock & P&L', Icon: Package }, { id: 'costs', label: 'Costs', Icon: Receipt }] },
  { id: 'sales', label: 'Sales & Profit', Icon: DollarSign, views: [{ id: 'ebaysales', label: 'eBay Sales · Real P&L' }] },
];
const sectionOf = (view) => SECTIONS.find((s) => s.views.some((v) => v.id === view)) || SECTIONS[0];
const SnapTab = lazy(() => import('./SnapTab.jsx'));
const CostsTab = lazy(() => import('./CostsTab.jsx'));
const BuyOffersTab = lazy(() => import('./BuyOffersTab.jsx'));
const CollectionTab = lazy(() => import('./CollectionTab.jsx'));
import { SNAP_DEFAULTS } from '../netlify/lib/snap-logic.js';
import { OFFER_DEFAULTS } from '../netlify/lib/offer-logic.js';
import { conditionFromEbay, extractAskPrice } from './pricing/pricingLogic.js';
import { DialogHost } from './lib/dialog.jsx';
import UpdateBanner from './UpdateBanner.jsx';
import { IS_TYCHE, BRAND, Wordmark, TycheEmblem } from './brand.jsx';
import { usePlan, PlanBadge, PlanPanel, Locked, locked, startCheckout } from './PlanPanel.jsx';

// Views that need a paid plan on Tyche Cards (the founder site has no plans).
const VIEW_FEATURE = { offers: 'buy_offers', collection: 'collection', repricer: 'repricer', costs: 'profit', ebaysales: 'profit' };

const DEFAULT_SETTINGS = {
  ebayFeePct: 13.25,
  ebayFeeFlat: 0.30,
  tcgFeePct: 10.25,
  tcgPaymentPct: 2.5,
  defaultShipping: 1.00,
  sharpnessThreshold: 20,
  minProfitDollars: 5,
  ...SNAP_DEFAULTS, // Snap to List: model, markup, minimum, price ending, monthly AI budget
  ...OFFER_DEFAULTS, // Buy offers: bulk cutoff and flat price, mid/high % of market
};

const GAMES = ['Pokémon', 'MTG', 'Yu-Gi-Oh!', 'One Piece', 'Lorcana', 'Other'];
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG', 'PSA 10', 'PSA 9', 'PSA 8', 'PSA 7', 'BGS 10', 'BGS 9.5', 'BGS 9', 'CGC 10', 'CGC 9.5', 'CGC 9', 'SGC 10', 'SGC 9'];
// Keeps an unusual detected grade (e.g. PSA 6) selectable instead of silently showing the first option.
const conditionOptions = (current) => (current && !CONDITIONS.includes(current) ? [...CONDITIONS, current] : CONDITIONS);
const CHANNELS = ['eBay', 'TCGplayer', 'Cardmarket', 'LGS', 'Private', 'Other'];
const LIQUIDITY_TIERS = ['High', 'Medium', 'Low', 'Dead Stock'];

function getSharpness(askPrice, fmv) {
  if (!askPrice || !fmv || fmv <= 0) return null;
  const discount = ((fmv - askPrice) / fmv) * 100;
  if (discount >= 30) return { label: 'Strong Buy', emoji: '🔥', tier: 'sharp-strong', discount };
  if (discount >= 20) return { label: 'Good Deal', emoji: '✅', tier: 'sharp-good', discount };
  if (discount >= 10) return { label: 'Marginal', emoji: '🟡', tier: 'fair', discount };
  if (discount >= 0)  return { label: 'At Market', emoji: '⚪', tier: 'at-market', discount };
  return { label: 'Overpriced', emoji: '❌', tier: 'overpriced', discount };
}

function calcNetProceeds(salePrice, channel, settings, shippingOut = 0) {
  if (channel === 'eBay') return salePrice * (1 - settings.ebayFeePct / 100) - settings.ebayFeeFlat - shippingOut;
  if (channel === 'TCGplayer') return salePrice * (1 - (settings.tcgFeePct + settings.tcgPaymentPct) / 100) - shippingOut;
  return salePrice - shippingOut;
}

function fmt(n) { if (n === null || n === undefined || isNaN(n)) return '—'; return `$${Number(n).toFixed(2)}`; }
function fmtPct(n) { if (n === null || n === undefined || isNaN(n)) return '—'; return `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`; }
function computeMedian(arr) {
  const sorted = arr.filter(n => !isNaN(n)).sort((a,b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}


export default function CardDeskPro({ session }) {
  const userId = session.user.id;
  // Collection cards that hit a target or growth %: a badge on the tab and a notice on every page.
  const [collectionAlerts, setCollectionAlerts] = useState(0);
  const loadCollectionAlerts = useCallback(async () => {
    const { count } = await supabase.from('collection_items').select('id', { count: 'exact', head: true }).eq('status', 'held').eq('alert_state', 'active');
    setCollectionAlerts(count || 0);
  }, []);
  useEffect(() => { loadCollectionAlerts(); }, [loadCollectionAlerts]);
  useLivingTouches();
  const [tab, setTab] = useState(() => {
    const asked = new URLSearchParams(window.location.search).get('tab');
    return SECTIONS.some((s) => s.views.some((v) => v.id === asked)) ? asked : 'snap';
  });
  // The view last open in each section, so switching sections and back returns to it.
  const [lastView, setLastView] = useState({});
  useEffect(() => { setLastView((m) => ({ ...m, [sectionOf(tab).id]: tab })); }, [tab]);
  const section = sectionOf(tab);
  // ---------- Tyche Cards plan ----------
  const plan = usePlan(IS_TYCHE);
  const [planOpen, setPlanOpen] = useState(null);   // null | { reason }
  const [billingMsg, setBillingMsg] = useState(null);
  useEffect(() => {
    if (!IS_TYCHE) return undefined;
    const onUpgrade = (e) => { setPlanOpen({ reason: e.detail?.error || null }); window.dispatchEvent(new Event('tyche:plan-changed')); };
    window.addEventListener('tyche:upgrade', onUpgrade);
    // Back from Stripe, or arriving from a homepage plan button.
    const q = new URLSearchParams(window.location.search);
    const clean = () => window.history.replaceState(null, '', window.location.pathname);
    if (q.get('billing') === 'success') { setBillingMsg({ ok: true, text: 'Thanks! Your plan is active. It can take a few seconds to show here.' }); clean(); setTimeout(() => window.dispatchEvent(new Event('tyche:plan-changed')), 3000); }
    else if (q.get('billing') === 'cancelled') { setBillingMsg({ ok: false, text: 'Checkout was cancelled. You\'re still on your current plan.' }); clean(); }
    else if (q.get('plan') && q.get('interval')) { clean(); startCheckout(q.get('plan'), q.get('interval')).catch((err) => setBillingMsg({ ok: false, text: err.message })); }
    return () => window.removeEventListener('tyche:upgrade', onUpgrade);
  }, []);
  const lockedFeature = locked(plan, VIEW_FEATURE[tab]) ? VIEW_FEATURE[tab] : null;
  const [dataError, setDataError] = useState(null);
  const { settings, setSettings, loaded: settingsLoaded } = useSettings(userId, DEFAULT_SETTINGS, setDataError);
  const { items: watchlist, setItems: setWatchlist, loaded: watchLoaded, reload: reloadWatchlist } = useCollection('watchlist', userId, setDataError);
  const { items: comps, setItems: setComps, loaded: compsLoaded, reload: reloadComps } = useCollection('comps', userId, setDataError);
  const { items: inventory, setItems: setInventory, loaded: invLoaded, reload: reloadInventory } = useCollection('inventory', userId, setDataError);
  const dataLoaded = settingsLoaded && watchLoaded && compsLoaded && invLoaded;
  // eBay sales sync marks cards sold on the server. Re-read inventory when opening a screen that
  // shows or edits it, so a stale copy here can't overwrite that (e.g. flip a sold card back to In Stock).
  useEffect(() => {
    if (invLoaded && ['inventory', 'repricer', 'analyzer', 'costs'].includes(tab)) reloadInventory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const [legacyLocal, setLegacyLocal] = useState(() => readLegacyLocalData());
  const [importMsg, setImportMsg] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const [aCardName, setACardName] = useState('');
  const [aGame, setAGame] = useState('Pokémon');
  const [aSet, setASet] = useState('');
  const [aCondition, setACondition] = useState('NM');
  const [aAskPrice, setAAskPrice] = useState('');
  const [aShippingIn, setAShippingIn] = useState('');
  const [aFmv, setAFmv] = useState('');
  const [aResaleChannel, setAResaleChannel] = useState('eBay');
  const [aShippingOut, setAShippingOut] = useState('1.00');
  const [aLiquidity, setALiquidity] = useState('Medium');

  // URL paste state
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteLoading, setPasteLoading] = useState(false);
  const [pasteMsg, setPasteMsg] = useState(null);

  async function handleUrlPaste() {
    if (!pasteUrl.trim()) return;
    setPasteLoading(true);
    setPasteMsg(null);
    try {
      const res = await apiFetch(`/api/parse-listing?url=${encodeURIComponent(pasteUrl)}`);
      const data = await res.json();
      if (data.error) {
        setPasteMsg({ type: 'error', text: data.error });
      } else {
        setACardName(data.cardName || data.title || '');
        setAAskPrice(data.price ? String(data.price) : '');
        setAShippingIn(data.shippingCost ? String(data.shippingCost) : '0');
        setACondition(conditionFromEbay(data.condition, data.title));
        const m = (data.title || '').match(/pok[ée]mon|pokemon/i);
        if (m) setAGame('Pokémon');
        else if (/magic|mtg/i.test(data.title || '')) setAGame('MTG');
        setPasteMsg({
          type: 'success',
          text: `Loaded from ${data.source}. Verify fields below, then enter FMV.${data.note ? ' ' + data.note : ''}`,
        });
      }
    } catch (err) {
      setPasteMsg({ type: 'error', text: 'Network error. Make sure the URL is from eBay or TCGplayer.' });
    } finally {
      setPasteLoading(false);
    }
  }

  useEffect(() => {
    if (!aCardName) return;
    const nameLow = aCardName.toLowerCase().trim();
    const setLow = aSet.toLowerCase().trim();
    const matchingComps = comps.filter(c =>
      c.cardName.toLowerCase().trim() === nameLow &&
      (!setLow || c.set.toLowerCase().trim() === setLow) &&
      c.condition === aCondition
    );
    if (matchingComps.length > 0 && !aFmv) {
      const median = computeMedian(matchingComps.map(c => parseFloat(c.salePrice)));
      if (median) setAFmv(median.toFixed(2));
      return;
    }
    const matchingWatch = watchlist.find(w =>
      w.cardName.toLowerCase().trim() === nameLow &&
      (!setLow || w.set.toLowerCase().trim() === setLow)
    );
    if (matchingWatch && matchingWatch.targetFmv && !aFmv) setAFmv(matchingWatch.targetFmv);
  }, [aCardName, aSet, aCondition]);

  const analyzerResult = useMemo(() => {
    const ask = parseFloat(aAskPrice);
    const fmv = parseFloat(aFmv);
    const shipIn = parseFloat(aShippingIn) || 0;
    const shipOut = parseFloat(aShippingOut) || 0;
    if (!(ask > 0) || !(fmv > 0)) return null; // negative/zero values would leave no verdict tier to show
    const totalCost = ask + shipIn;
    const netIfResold = calcNetProceeds(fmv, aResaleChannel, settings, shipOut);
    const profit = netIfResold - totalCost;
    const marginPct = totalCost > 0 ? (profit / totalCost) * 100 : 0;
    const sharpness = getSharpness(ask, fmv);
    const passesFilters = sharpness && sharpness.discount >= settings.sharpnessThreshold && profit >= settings.minProfitDollars;
    return { totalCost, netIfResold, profit, marginPct, sharpness, passesFilters, fmv, ask };
  }, [aAskPrice, aFmv, aShippingIn, aShippingOut, aResaleChannel, settings]);

  const resetAnalyzer = () => {
    setACardName(''); setASet(''); setAAskPrice(''); setAShippingIn('');
    setAFmv(''); setAShippingOut('1.00'); setACondition('NM'); setALiquidity('Medium');
    setPasteUrl(''); setPasteMsg(null);
  };

  const saveToWatchlist = () => {
    if (!aCardName || !aFmv) return;
    setWatchlist([{
      id: newId(), cardName: aCardName, game: aGame, set: aSet, condition: aCondition,
      targetFmv: aFmv,
      maxBuy: ((parseFloat(aFmv) * (1 - settings.sharpnessThreshold / 100))).toFixed(2),
      liquidity: aLiquidity, added: new Date().toISOString(),
    }, ...watchlist]);
  };

  const addToInventory = () => {
    if (!aCardName || !aAskPrice) return;
    setInventory([{
      id: newId(), cardName: aCardName, game: aGame, set: aSet, condition: aCondition,
      purchasePrice: aAskPrice, shippingIn: aShippingIn || '0',
      costBasis: ((parseFloat(aAskPrice) || 0) + (parseFloat(aShippingIn) || 0)).toFixed(2),
      currentFmv: aFmv || '', liquidity: aLiquidity, status: 'In Stock',
      acquired: new Date().toISOString().slice(0, 10),
      sold: null, salePrice: '', saleChannel: '', shippingOut: '',
    }, ...inventory]);
  };

  // -------- LIVE SEARCH STATE --------
  const [searchQuery, setSearchQuery] = useState('');
  const [searchSort, setSearchSort] = useState('price');
  const [searchFmv, setSearchFmv] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState(null);
  const [searchError, setSearchError] = useState(null);

  async function runLiveSearch() {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    setSearchResults(null);
    try {
      const res = await apiFetch(`/api/ebay-search?q=${encodeURIComponent(searchQuery)}&sort=${searchSort}&limit=30`);
      const data = await res.json();
      if (data.error) {
        setSearchError(data.detail || data.error);
      } else {
        setSearchResults(data.items || []);
      }
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearchLoading(false);
    }
  }

  const searchFmvNum = parseFloat(searchFmv) || 0;
  // Auto-suggest FMV from watchlist when the search query matches
  useEffect(() => {
    if (!searchQuery || searchFmv) return;
    const nameLow = searchQuery.toLowerCase().trim();
    const matchingWatch = watchlist.find(w => {
      const w1 = w.cardName.toLowerCase();
      return nameLow.includes(w1) || w1.includes(nameLow);
    });
    if (matchingWatch && matchingWatch.targetFmv) setSearchFmv(matchingWatch.targetFmv);
  }, [searchQuery]);

  function sendResultToAnalyzer(item) {
    setACardName(item.title);
    setAAskPrice(String(item.price));
    setAShippingIn(String(item.shippingCost || 0));
    setACondition(conditionFromEbay(item.condition, item.title));
    if (searchFmvNum > 0) setAFmv(String(searchFmvNum));
    setTab('analyzer');
  }

  // ---- WATCHLIST / SCANNER ----
  const [pasteText, setPasteText] = useState('');
  const [pasteResults, setPasteResults] = useState(null);

  const scanPastedListings = () => {
    const lines = pasteText.split('\n').map(l => l.trim()).filter(Boolean);
    const results = [];
    for (const line of lines) {
      const found = extractAskPrice(line); // skips card numbers like 020/189 and grades like PSA 10
      if (!found) continue;
      const price = found.price;
      const at = found.index ?? line.indexOf(found.token);
      const nameRaw = (line.slice(0, at) + line.slice(at + found.token.length)).replace(/[|@-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!nameRaw) continue;
      const nameLow = nameRaw.toLowerCase();
      const match = watchlist.find(w => {
        const w1 = w.cardName.toLowerCase();
        return nameLow.includes(w1) || w1.includes(nameLow);
      });
      if (match) {
        const fmv = parseFloat(match.targetFmv);
        const sharpness = getSharpness(price, fmv);
        results.push({ line, price, match, sharpness, passes: sharpness && sharpness.discount >= settings.sharpnessThreshold });
      } else {
        results.push({ line, price, match: null, sharpness: null, passes: false });
      }
    }
    setPasteResults(results);
  };

  const removeWatch = (id) => setWatchlist(watchlist.filter(w => w.id !== id));
  const removeComp = (id) => setComps(comps.filter(c => c.id !== id));
  const removeInv = (id) => setInventory(inventory.filter(i => i.id !== id));

  const [cCardName, setCCardName] = useState('');
  const [cSet, setCSet] = useState('');
  const [cCondition, setCCondition] = useState('NM');
  const [cSalePrice, setCSalePrice] = useState('');
  const [cSource, setCSource] = useState('eBay');
  const [cDate, setCDate] = useState(new Date().toISOString().slice(0, 10));
  const [cGame, setCGame] = useState('Pokémon');

  const addComp = () => {
    if (!cCardName || !cSalePrice) return;
    setComps([{ id: newId(), cardName: cCardName, game: cGame, set: cSet, condition: cCondition, salePrice: cSalePrice, source: cSource, date: cDate }, ...comps]);
    setCCardName(''); setCSet(''); setCSalePrice('');
  };

  const [sellingId, setSellingId] = useState(null);
  const [sellPrice, setSellPrice] = useState('');
  const [sellChannel, setSellChannel] = useState('eBay');
  const [sellShipping, setSellShipping] = useState('1.00');

  const markSold = () => {
    if (!sellingId || !sellPrice) return;
    setInventory(inventory.map(i => i.id !== sellingId ? i : {
      ...i, status: 'Sold', salePrice: sellPrice, saleChannel: sellChannel, shippingOut: sellShipping, sold: new Date().toISOString().slice(0, 10),
    }));
    setSellingId(null); setSellPrice(''); setSellShipping('1.00');
  };

  const pnl = useMemo(() => {
    const sold = inventory.filter(i => i.status === 'Sold');
    const inStock = inventory.filter(i => i.status === 'In Stock');
    let realized = 0, costBasisSold = 0, totalSales = 0;
    sold.forEach(i => {
      const cb = parseFloat(i.costBasis) || 0;
      const sp = parseFloat(i.salePrice) || 0;
      const ship = parseFloat(i.shippingOut) || 0;
      const net = calcNetProceeds(sp, i.saleChannel, settings, ship);
      realized += (net - cb); costBasisSold += cb; totalSales += sp;
    });
    let unrealized = 0, invCost = 0, invMarket = 0;
    inStock.forEach(i => {
      const cb = parseFloat(i.costBasis) || 0;
      const fmv = parseFloat(i.currentFmv) || 0;
      invCost += cb; invMarket += fmv; unrealized += (fmv - cb);
    });
    const avgMargin = costBasisSold > 0 ? (realized / costBasisSold) * 100 : 0;
    // Only cards with both dates count; imported or eBay-synced cards often have no acquired date.
    const holds = sold.map(i => (new Date(i.sold) - new Date(i.acquired)) / 86400000).filter(Number.isFinite);
    const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
    return { realized, unrealized, invCost, invMarket, avgMargin, avgHold, soldCount: sold.length, stockCount: inStock.length, totalSales };
  }, [inventory, settings]);

  const exportData = () => {
    const blob = new Blob([JSON.stringify({ watchlist, comps, inventory, settings, exportedAt: new Date().toISOString(), version: 2 }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `carddesk-backup-${new Date().toISOString().slice(0,10)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  async function runImport(data, label) {
    setImportMsg({ ok: true, text: `Importing ${label}…` });
    try {
      const counts = await importBackup(data, userId);
      await Promise.all([reloadInventory(), reloadWatchlist(), reloadComps()]);
      if (counts.settings && data.settings) setSettings({ ...DEFAULT_SETTINGS, ...data.settings });
      const parts = ['inventory', 'watchlist', 'comps']
        .filter(t => counts[t].found)
        .map(t => `${counts[t].added} of ${counts[t].found} ${t}`);
      const skipped = ['inventory', 'watchlist', 'comps'].reduce((n, t) => n + counts[t].found - counts[t].added, 0);
      setImportMsg({ ok: true, text: `Imported ${parts.join(', ') || 'nothing'}${counts.settings ? ' + settings' : ''}.${skipped ? ` ${skipped} were already in your account and were skipped.` : ''}` });
      return true;
    } catch (err) {
      setImportMsg({ ok: false, text: `Import failed: ${err.message}` });
      return false;
    }
  }

  const importData = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let data;
      try { data = JSON.parse(ev.target.result); }
      catch (err) { setImportMsg({ ok: false, text: 'Invalid backup file: ' + err.message }); return; }
      runImport(data, file.name);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  async function importLegacyLocal() {
    if (!legacyLocal) return;
    const ok = await runImport(legacyLocal.data, 'data saved in this browser');
    if (ok) { markLegacyLocalDataHandled(); setLegacyLocal(null); }
  }
  function dismissLegacyLocal() { markLegacyLocalDataHandled(); setLegacyLocal(null); }

  if (!dataLoaded && !dataError) {
    return <div className="center-screen"><span className="quiet">Loading your data…</span><Hedge sign={false} /></div>;
  }

  return (
    <div className="app-shell">

      <div className="sky">
        <Clouds />
        <header className="app-pad" style={{ padding: '22px 32px 14px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div className="sky-text">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              {IS_TYCHE && <span style={{ alignSelf: 'center' }}><TycheEmblem height={44} alt="" /></span>}
              <Wordmark />
              <span className="quiet" style={{ fontSize: '0.8rem' }}>{BRAND.tagline}</span>
            </div>
            <div className="ink-dim" style={{ fontSize: '0.78rem', fontWeight: 600, marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span><span className="pulse-dot"></span> {watchlist.length} watched</span>
              <span>{inventory.filter(i => i.status === 'In Stock').length} in stock</span>
              <span>{comps.length} comps logged</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PlanBadge plan={plan} onOpen={() => setPlanOpen({ reason: null })} />
            <button className="btn-ghost" onClick={exportData} style={{ padding: '8px 12px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={14} /> Backup</button>
            <label className="btn-ghost" style={{ padding: '8px 12px', fontSize: '0.8rem', fontWeight: 400, letterSpacing: 0, margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--ink)' }}>
              <Upload size={14} /> Import backup<input type="file" accept=".json" onChange={importData} style={{ display: 'none' }} />
            </label>
            <button className="btn-ghost" onClick={() => setShowSettings(true)} style={{ padding: '8px 12px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Settings size={14} /> Settings</button>
            <button className="btn-ghost" onClick={() => supabase.auth.signOut()} title={`Signed in as ${session.user.email}`} style={{ padding: '8px 12px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><LogOut size={14} /> Sign out</button>
          </div>
        </header>
        <Hedge number={SECTIONS.indexOf(section) + 1} />
      </div>

      {billingMsg && (
        <div className="app-pad" role="status" style={{ padding: '10px 32px', background: billingMsg.ok ? 'var(--good-wash)' : 'var(--warn-wash)', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: '0.85rem' }}>
          <span>{billingMsg.text}</span><button className="btn-icon" aria-label="Dismiss" onClick={() => setBillingMsg(null)}><X size={14} /></button>
        </div>
      )}
      {planOpen && <PlanPanel plan={plan} reason={planOpen.reason} onClose={() => setPlanOpen(null)} />}
      {collectionAlerts > 0 && tab !== 'collection' && (
        <div className="app-pad" role="status" style={{ padding: '10px 32px', background: 'var(--warn-wash)', borderBottom: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.85rem' }}>
          <Bell size={15} className="accent-amber" />
          <span>{collectionAlerts} collection card{collectionAlerts === 1 ? ' is' : 's are'} ready to review for listing.</span>
          <button className="btn-ghost" onClick={() => setTab('collection')} style={{ padding: '4px 10px', fontSize: '0.78rem' }}>Review</button>
        </div>
      )}
      {legacyLocal && (
        <div className="app-pad" style={{ padding: '12px 32px', background: 'var(--warn-wash)', borderBottom: '1px solid var(--warn)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem' }}>
          <span className="accent-amber">This browser still has {legacyLocal.total} items from the old CardDesk (before accounts). Copy them into your account?</span>
          <button className="btn-primary" onClick={importLegacyLocal} style={{ padding: '6px 14px' }}>Import them</button>
          <button className="btn-ghost" onClick={dismissLegacyLocal} style={{ padding: '6px 12px', fontSize: '0.75rem' }}>Not now, don't ask again</button>
        </div>
      )}
      {(importMsg || dataError) && (
        <div className="app-pad" style={{ padding: '10px 32px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.8rem' }}>
          <span className={dataError || (importMsg && !importMsg.ok) ? 'accent-red' : 'accent-green'}>{dataError || importMsg.text}</span>
          <button className="btn-icon" onClick={() => { setImportMsg(null); setDataError(null); }}><X size={14} /></button>
        </div>
      )}

      <nav className="trail app-pad" style={{ paddingLeft: 32, paddingRight: 32 }} aria-label="Sections">
        {SECTIONS.map((s) => (
          <button key={s.id} className={`tab-btn ${section.id === s.id ? 'active' : ''}`} aria-current={section.id === s.id ? 'page' : undefined}
            onClick={() => setTab(lastView[s.id] || s.views[0].id)}>
            <span className="hex"><s.Icon size={13} strokeWidth={2.4} /></span>{s.label}
            {s.views.every((v) => locked(plan, VIEW_FEATURE[v.id])) && <span className="ink-faint" aria-label="needs an upgrade" style={{ fontSize: '0.7rem' }}> · {plan && ({ buy_offers: 'Elite', collection: 'Pro', profit: 'Pro' }[VIEW_FEATURE[s.views[0].id]])}</span>}
            {s.id === 'collection' && collectionAlerts > 0 && <span className="tab-badge" aria-label={`${collectionAlerts} ready to review`}>{collectionAlerts}</span>}
          </button>
        ))}
      </nav>
      {section.views.length > 1 && (
        <nav className="subtrail app-pad" style={{ paddingLeft: 32, paddingRight: 32 }} aria-label={`${section.label} views`}>
          {section.views.map((v) => (
            <button key={v.id} className={`subtab ${tab === v.id ? 'active' : ''}`} aria-current={tab === v.id ? 'page' : undefined} onClick={() => setTab(v.id)}>
              {v.Icon && <v.Icon size={13} />}{v.label}
            </button>
          ))}
        </nav>
      )}

      <main className="app-pad" style={{ padding: '32px', maxWidth: 1400, margin: '0 auto' }}>

        {lockedFeature && <Locked feature={lockedFeature} onUpgrade={() => setPlanOpen({ reason: null })} />}
        {/* ============ DEAL ANALYZER ============ */}
        {tab === 'analyzer' && (
          <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <section className="bg-card" style={{ padding: 24 }}>
              <h2 className="display-font" style={{ fontSize: '1.5rem', marginTop: 0, marginBottom: 4 }}>
                <Target size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} />
                ANALYZE A LISTING
              </h2>
              <p className="ink-dim" style={{ marginTop: 0, fontSize: '0.8rem' }}>Paste an eBay or TCGplayer URL to auto-fill, or enter manually below.</p>

              {/* URL PASTE */}
              <div style={{ background: 'var(--field)', padding: 12, border: '1px solid var(--line)', marginBottom: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Link2 size={12} /> Paste Listing URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="bg-input" placeholder="https://www.ebay.com/itm/..." value={pasteUrl} onChange={e => setPasteUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleUrlPaste()} />
                  <button className="btn-primary" onClick={handleUrlPaste} disabled={pasteLoading || !pasteUrl.trim()} style={{ padding: '8px 16px', minWidth: 90 }}>
                    {pasteLoading ? <Loader size={14} className="spin" /> : 'FETCH'}
                  </button>
                </div>
                {pasteMsg && (
                  <div style={{ marginTop: 8, padding: 8, fontSize: '0.75rem', background: pasteMsg.type === 'error' ? 'var(--accent-wash)' : 'var(--good-wash)', borderLeft: `3px solid ${pasteMsg.type === 'error' ? 'var(--accent)' : 'var(--good)'}` }}>
                    {pasteMsg.text}
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ gridColumn: 'span 2' }}><label>Card Name</label><input className="bg-input" value={aCardName} onChange={e => setACardName(e.target.value)} placeholder="e.g. Charizard VMAX" /></div>
                <div><label>Game</label><select className="bg-input" value={aGame} onChange={e => setAGame(e.target.value)}>{GAMES.map(g => <option key={g}>{g}</option>)}</select></div>
                <div><label>Set / Edition</label><input className="bg-input" value={aSet} onChange={e => setASet(e.target.value)} placeholder="e.g. Darkness Ablaze" /></div>
                <div><label>Condition / Grade</label><select className="bg-input" value={aCondition} onChange={e => setACondition(e.target.value)}>{conditionOptions(aCondition).map(c => <option key={c}>{c}</option>)}</select></div>
                <div><label>Liquidity</label><select className="bg-input" value={aLiquidity} onChange={e => setALiquidity(e.target.value)}>{LIQUIDITY_TIERS.map(l => <option key={l}>{l}</option>)}</select></div>
                <div><label>Ask Price ($)</label><input className="bg-input" type="number" step="0.01" value={aAskPrice} onChange={e => setAAskPrice(e.target.value)} placeholder="0.00" /></div>
                <div><label>Shipping In ($)</label><input className="bg-input" type="number" step="0.01" value={aShippingIn} onChange={e => setAShippingIn(e.target.value)} placeholder="0.00" /></div>
                <div><label>Fair Market Value ($)</label><input className="bg-input" type="number" step="0.01" value={aFmv} onChange={e => setAFmv(e.target.value)} placeholder="enter manually" /></div>
                <div><label>Resale Channel</label><select className="bg-input" value={aResaleChannel} onChange={e => setAResaleChannel(e.target.value)}><option>eBay</option><option>TCGplayer</option><option>Cardmarket</option><option>Other</option></select></div>
                <div><label>Shipping Out ($)</label><input className="bg-input" type="number" step="0.01" value={aShippingOut} onChange={e => setAShippingOut(e.target.value)} /></div>
              </div>

              <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn-primary" onClick={saveToWatchlist} disabled={!aCardName || !aFmv} style={{ padding: '10px 20px' }}>+ Add to Watchlist</button>
                <button className="btn-ghost" onClick={addToInventory} disabled={!aCardName || !aAskPrice} style={{ padding: '10px 16px' }}>+ Add to Inventory</button>
                <button className="btn-ghost" onClick={resetAnalyzer} style={{ padding: '10px 16px' }}>Clear</button>
              </div>
            </section>

            <section>
              {analyzerResult ? (
                <div className={`bg-card ${analyzerResult.sharpness.tier}`} style={{ padding: 24, borderWidth: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                    <h2 className="display-font" style={{ fontSize: '1.5rem', margin: 0 }}>VERDICT</h2>
                    {analyzerResult.passesFilters && (<div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', color: 'var(--accent)' }}><Flame size={14} /> PASSES FILTERS</div>)}
                  </div>
                  <div style={{ fontSize: '3rem', fontWeight: 700, lineHeight: 1, marginBottom: 4 }}>{analyzerResult.sharpness.emoji} {fmtPct(analyzerResult.sharpness.discount)}</div>
                  <div className="display-font" style={{ fontSize: '1.4rem', marginBottom: 24 }}>{analyzerResult.sharpness.label.toUpperCase()} — vs. FMV</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>YOU PAY</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{fmt(analyzerResult.totalCost)}</div></div>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>NET IF RESOLD</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{fmt(analyzerResult.netIfResold)}</div></div>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>PROFIT</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }} className={analyzerResult.profit >= 0 ? 'accent-green' : 'accent-red'}>{fmt(analyzerResult.profit)}</div></div>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>MARGIN</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }} className={analyzerResult.marginPct >= 0 ? 'accent-green' : 'accent-red'}>{fmtPct(analyzerResult.marginPct)}</div></div>
                  </div>
                  <div style={{ padding: 12, background: 'var(--well)', fontSize: '0.8rem', borderLeft: '3px solid var(--accent)' }}>
                    {analyzerResult.sharpness.tier === 'sharp-strong' && '🔥 Rare opportunity. Act fast if condition checks out. Verify seller and photos before clicking buy.'}
                    {analyzerResult.sharpness.tier === 'sharp-good' && '✅ Solid margin after fees. This is the kind of deal that pays the bills.'}
                    {analyzerResult.sharpness.tier === 'fair' && '🟡 Marginal. Only worth it if liquidity is high or you have a buyer lined up.'}
                    {analyzerResult.sharpness.tier === 'at-market' && '⚪ No edge. Pass unless you want it personally.'}
                    {analyzerResult.sharpness.tier === 'overpriced' && '❌ Overpriced. Walk away.'}
                  </div>
                </div>
              ) : (
                <div className="bg-card" style={{ padding: 24, minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                  <Target size={48} className="ink-faint" style={{ marginBottom: 16 }} />
                  <div className="ink-dim" style={{ textAlign: 'center', maxWidth: 320, fontSize: '0.85rem' }}>Enter ask price and FMV to see the verdict.</div>
                </div>
              )}
              <div className="bg-card" style={{ padding: 16, marginTop: 16 }}>
                <h3 style={{ margin: 0, fontSize: '0.85rem', letterSpacing: '0.1em', color: 'var(--ink-dim)', textTransform: 'uppercase', marginBottom: 12 }}>FMV Lookup Links</h3>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {aCardName ? (
                    <>
                      <a className="btn-ghost" target="_blank" rel="noreferrer" style={{ padding: '8px 12px', fontSize: '0.8rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }} href={`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(aCardName + ' ' + aSet)}&LH_Sold=1&LH_Complete=1`}>eBay Sold <ExternalLink size={12} /></a>
                      <a className="btn-ghost" target="_blank" rel="noreferrer" style={{ padding: '8px 12px', fontSize: '0.8rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }} href={`https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(aCardName + ' ' + aSet)}`}>TCGplayer <ExternalLink size={12} /></a>
                      <a className="btn-ghost" target="_blank" rel="noreferrer" style={{ padding: '8px 12px', fontSize: '0.8rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }} href={`https://www.pricecharting.com/search-products?q=${encodeURIComponent(aCardName + ' ' + aSet)}&type=prices`}>PriceCharting <ExternalLink size={12} /></a>
                      {aCondition.startsWith('PSA') && (<a className="btn-ghost" target="_blank" rel="noreferrer" style={{ padding: '8px 12px', fontSize: '0.8rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }} href={`https://www.psacard.com/auctionprices/search?q=${encodeURIComponent(aCardName)}`}>PSA APR <ExternalLink size={12} /></a>)}
                    </>
                  ) : <span className="ink-faint" style={{ fontSize: '0.8rem' }}>Enter a card name to generate links</span>}
                </div>
              </div>
            </section>
          </div>
        )}

        {/* ============ LIVE SEARCH ============ */}
        {tab === 'livesearch' && (
          <div>
            <div className="bg-card" style={{ padding: 24 }}>
              <h2 className="display-font" style={{ fontSize: '1.5rem', marginTop: 0, marginBottom: 4 }}>
                <Zap size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} /> LIVE eBAY SEARCH
              </h2>
              <p className="ink-dim" style={{ marginTop: 0, fontSize: '0.85rem' }}>
                Searches active eBay listings in real time. Enter an FMV to auto-score each result against your sharpness threshold.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 12, marginTop: 16, alignItems: 'end' }} className="responsive-grid">
                <div><label>Search Query</label><input className="bg-input" placeholder="e.g. Charizard VMAX Darkness Ablaze" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && runLiveSearch()} /></div>
                <div><label>FMV ($) — for scoring</label><input className="bg-input" type="number" step="0.01" value={searchFmv} onChange={e => setSearchFmv(e.target.value)} placeholder="optional" /></div>
                <div><label>Sort</label><select className="bg-input" value={searchSort} onChange={e => setSearchSort(e.target.value)}><option value="price">Price (Low → High)</option><option value="newlyListed">Newly Listed</option><option value="bestMatch">Best Match</option></select></div>
                <button className="btn-primary" onClick={runLiveSearch} disabled={searchLoading || !searchQuery.trim()} style={{ padding: '10px 20px', height: 42 }}>
                  {searchLoading ? <Loader size={14} className="spin" /> : '▶ SEARCH'}
                </button>
              </div>

              {searchError && (
                <div style={{ marginTop: 16, padding: 12, background: 'var(--accent-wash)', borderLeft: '3px solid var(--accent)', fontSize: '0.8rem' }}>
                  <strong className="accent-red">Error:</strong> {searchError}
                  <div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 4 }}>If this is a 401/auth error, check that EBAY_APP_ID and EBAY_CERT_ID are set in your Netlify environment variables.</div>
                </div>
              )}
            </div>

            {searchResults && (
              <div className="bg-card" style={{ padding: 0, marginTop: 16 }}>
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <h3 className="display-font" style={{ fontSize: '1.2rem', margin: 0 }}>RESULTS · {searchResults.length} ITEMS</h3>
                  {searchFmvNum > 0 && (<div className="ink-dim" style={{ fontSize: '0.75rem' }}>Scored vs. FMV {fmt(searchFmvNum)} · threshold {settings.sharpnessThreshold}%</div>)}
                </div>
                <div className="scrollable">
                  {searchResults.length === 0 ? (
                    <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">No results for that query. Try different search terms.</div>
                  ) : searchResults.map((item, idx) => {
                    const totalPrice = item.price + (item.shippingCost || 0);
                    const sharpness = searchFmvNum > 0 ? getSharpness(totalPrice, searchFmvNum) : null;
                    return (
                      <div key={item.id || idx} style={{ padding: 16, borderBottom: '1px solid var(--line-soft)', display: 'grid', gridTemplateColumns: '60px 1fr auto', gap: 16, alignItems: 'center' }}>
                        {item.image ? <img src={item.image} alt="" style={{ width: 60, height: 60, objectFit: 'contain', background: 'var(--well)' }} /> : <div style={{ width: 60, height: 60, background: 'var(--well)' }} />}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '0.85rem', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{item.title}</div>
                          <div style={{ fontSize: '0.7rem', display: 'flex', gap: 12, flexWrap: 'wrap' }} className="ink-dim">
                            <span><strong>{fmt(item.price)}</strong> {item.shippingCost > 0 ? `+ ${fmt(item.shippingCost)} ship` : '+ free ship'}</span>
                            <span>{item.condition}</span>
                            <span>{item.seller} {item.sellerFeedback && `(${item.sellerFeedback}%)`}</span>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                          {sharpness && (<span className={sharpness.tier} style={{ padding: '4px 10px', fontSize: '0.7rem', border: '1px solid', display: 'inline-block' }}>{sharpness.emoji} {fmtPct(sharpness.discount)}</span>)}
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn-ghost" onClick={() => sendResultToAnalyzer(item)} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>Analyze</button>
                            <a className="btn-ghost" href={item.url} target="_blank" rel="noreferrer" style={{ padding: '4px 8px', fontSize: '0.7rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}><ExternalLink size={12} /></a>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============ BULK SCANNER ============ */}
        {tab === 'scanner' && (
          <div>
            <div className="bg-card" style={{ padding: 24 }}>
              <h2 className="display-font" style={{ fontSize: '1.5rem', marginTop: 0, marginBottom: 4 }}><Search size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} /> BULK LISTING SCANNER</h2>
              <p className="ink-dim" style={{ marginTop: 0, fontSize: '0.85rem' }}>Paste listings, one per line. Cards on your watchlist get scored. Use this for sale lists from Facebook groups, Discord, or LGS inventory.</p>
              <textarea className="bg-input" rows={8} value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="Paste listings here, one per line..." style={{ fontFamily: 'inherit', marginTop: 12 }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn-primary" onClick={scanPastedListings} disabled={!pasteText.trim()} style={{ padding: '10px 24px' }}>▶ Scan {pasteText.split('\n').filter(l => l.trim()).length} lines</button>
                <button className="btn-ghost" onClick={() => { setPasteText(''); setPasteResults(null); }} style={{ padding: '10px 16px' }}>Clear</button>
              </div>
            </div>
            {pasteResults && (
              <div className="bg-card" style={{ padding: 0, marginTop: 16 }}>
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 className="display-font" style={{ fontSize: '1.2rem', margin: 0 }}>SCAN RESULTS</h3>
                  <div style={{ fontSize: '0.75rem' }} className="ink-dim">{pasteResults.filter(r => r.passes).length} flagged · {pasteResults.filter(r => r.match).length} matched</div>
                </div>
                <div className="scrollable">
                  {pasteResults.map((r, i) => (
                    <div key={i} className="grid-row" style={{ gridTemplateColumns: '1fr 100px 100px 120px 140px' }}>
                      <div>
                        <div style={{ fontSize: '0.85rem' }}>{r.line}</div>
                        {r.match ? <div className="ink-faint" style={{ fontSize: '0.7rem' }}>→ matched: {r.match.cardName}</div> : <div className="accent-amber" style={{ fontSize: '0.7rem' }}>⚠ no watchlist match</div>}
                      </div>
                      <div style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(r.price)}</div>
                      <div style={{ textAlign: 'right' }} className="ink-dim">{r.match ? fmt(parseFloat(r.match.targetFmv)) : '—'}</div>
                      <div style={{ textAlign: 'right' }} className={r.sharpness ? (r.sharpness.discount >= 0 ? 'accent-green' : 'accent-red') : 'ink-faint'}>{r.sharpness ? fmtPct(r.sharpness.discount) : '—'}</div>
                      <div style={{ textAlign: 'right' }}>{r.sharpness ? <span className={r.sharpness.tier} style={{ padding: '4px 10px', fontSize: '0.7rem', border: '1px solid', display: 'inline-block' }}>{r.sharpness.emoji} {r.sharpness.label.toUpperCase()}</span> : <span className="ink-faint">—</span>}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============ WATCHLIST ============ */}
        {tab === 'watchlist' && (
          <div className="bg-card" style={{ padding: 0 }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--line)' }}>
              <h2 className="display-font" style={{ fontSize: '1.5rem', margin: 0 }}><Eye size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} /> WATCHLIST · {watchlist.length} CARDS</h2>
              <p className="ink-dim" style={{ marginTop: 4, marginBottom: 0, fontSize: '0.8rem' }}>Max-buy auto-set to FMV minus your {settings.sharpnessThreshold}% threshold.</p>
            </div>
            {watchlist.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">No cards on watchlist yet. Add from the Deal Analyzer.</div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 120px 100px 90px 100px 100px 80px 40px', gap: 12, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: 'var(--ink-dim)', textTransform: 'uppercase', borderBottom: '1px solid var(--line-soft)' }}>
                  <div>Card</div><div>Game · Set</div><div>Cond.</div><div style={{ textAlign: 'right' }}>FMV</div><div style={{ textAlign: 'right' }}>Max Buy</div><div>Liquidity</div><div>Added</div><div></div>
                </div>
                {watchlist.map(w => (
                  <div key={w.id} className="grid-row" style={{ gridTemplateColumns: '2fr 120px 100px 90px 100px 100px 80px 40px' }}>
                    <div style={{ fontWeight: 500 }}>{w.cardName}</div>
                    <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{w.game}<br/>{w.set}</div>
                    <div>{w.condition}</div>
                    <div style={{ textAlign: 'right' }}>{fmt(parseFloat(w.targetFmv))}</div>
                    <div style={{ textAlign: 'right' }} className="accent-red">{fmt(parseFloat(w.maxBuy))}</div>
                    <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{w.liquidity}</div>
                    <div className="ink-faint" style={{ fontSize: '0.7rem' }}>{new Date(w.added).toLocaleDateString()}</div>
                    <div><button className="btn-icon" onClick={() => removeWatch(w.id)}><Trash2 size={14} /></button></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ============ COMPS ============ */}
        {tab === 'comps' && (
          <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 24 }}>
            <section className="bg-card" style={{ padding: 24 }}>
              <h2 className="display-font" style={{ fontSize: '1.3rem', marginTop: 0 }}>+ LOG A SOLD COMP</h2>
              <p className="ink-dim" style={{ fontSize: '0.8rem', marginTop: 0 }}>Median of matched comps auto-feeds the analyzer.</p>
              <div style={{ display: 'grid', gap: 12 }}>
                <div><label>Card Name</label><input className="bg-input" value={cCardName} onChange={e => setCCardName(e.target.value)} /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div><label>Game</label><select className="bg-input" value={cGame} onChange={e => setCGame(e.target.value)}>{GAMES.map(g => <option key={g}>{g}</option>)}</select></div>
                  <div><label>Condition</label><select className="bg-input" value={cCondition} onChange={e => setCCondition(e.target.value)}>{CONDITIONS.map(c => <option key={c}>{c}</option>)}</select></div>
                </div>
                <div><label>Set</label><input className="bg-input" value={cSet} onChange={e => setCSet(e.target.value)} /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div><label>Sale Price ($)</label><input className="bg-input" type="number" step="0.01" value={cSalePrice} onChange={e => setCSalePrice(e.target.value)} /></div>
                  <div><label>Source</label><select className="bg-input" value={cSource} onChange={e => setCSource(e.target.value)}>{CHANNELS.map(c => <option key={c}>{c}</option>)}</select></div>
                </div>
                <div><label>Date</label><input className="bg-input" type="date" value={cDate} onChange={e => setCDate(e.target.value)} /></div>
                <button className="btn-primary" onClick={addComp} disabled={!cCardName || !cSalePrice} style={{ padding: 10 }}>+ LOG COMP</button>
              </div>
            </section>
            <section className="bg-card" style={{ padding: 0 }}>
              <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)' }}><h2 className="display-font" style={{ fontSize: '1.3rem', margin: 0 }}>SOLD COMPS · {comps.length}</h2></div>
              {comps.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">No comps logged.</div> : (
                <div className="scrollable">
                  <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 80px 80px 80px 80px 90px 40px', gap: 8, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: 'var(--ink-dim)', textTransform: 'uppercase', borderBottom: '1px solid var(--line-soft)' }}>
                    <div>Card / Set</div><div>Cond.</div><div style={{ textAlign: 'right' }}>Price</div><div>Source</div><div>Date</div><div>Game</div><div></div>
                  </div>
                  {comps.map(c => (
                    <div key={c.id} className="grid-row" style={{ gridTemplateColumns: '1.5fr 80px 80px 80px 80px 90px 40px' }}>
                      <div><div>{c.cardName}</div><div className="ink-faint" style={{ fontSize: '0.7rem' }}>{c.set}</div></div>
                      <div>{c.condition}</div>
                      <div style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(parseFloat(c.salePrice))}</div>
                      <div className="ink-dim">{c.source}</div>
                      <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{c.date}</div>
                      <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{c.game}</div>
                      <div><button className="btn-icon" onClick={() => removeComp(c.id)}><Trash2 size={14} /></button></div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* ============ EBAY LISTINGS ============ */}
        {tab === 'listings' && <ListingsTab plan={plan} />}

        {/* ============ REPRICER ============ */}
        {tab === 'repricer' && !lockedFeature && (
          <RepricerTab comps={comps} inventory={inventory} settings={settings} onGoToComps={() => setTab('comps')} onGoToListings={() => setTab('listings')} />
        )}

        {/* ============ INVENTORY ============ */}
        {tab === 'inventory' && (
          <div>
            <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
              <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>REALIZED P&L</div><div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }} className={pnl.realized >= 0 ? 'accent-green' : 'accent-red'}>{fmt(pnl.realized)}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>{pnl.soldCount} sales · {fmt(pnl.totalSales)} gross</div></div>
              <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>UNREALIZED P&L</div><div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }} className={pnl.unrealized >= 0 ? 'accent-green' : 'accent-red'}>{fmt(pnl.unrealized)}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>{pnl.stockCount} in stock</div></div>
              <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>INVENTORY VALUE</div><div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }}>{fmt(pnl.invMarket)}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>{fmt(pnl.invCost)} at cost</div></div>
              <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>AVG MARGIN · HOLD</div><div style={{ fontSize: '1.6rem', fontWeight: 700, marginTop: 4 }} className={pnl.avgMargin >= 0 ? 'accent-green' : 'accent-red'}>{fmtPct(pnl.avgMargin)}</div><div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 2 }}>{Math.round(pnl.avgHold)} days avg</div></div>
            </div>
            <div className="bg-card" style={{ padding: 0 }}>
              <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--line)' }}><h2 className="display-font" style={{ fontSize: '1.3rem', margin: 0 }}>INVENTORY · {inventory.length} ITEMS</h2></div>
              {inventory.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">Inventory empty. Add items from Find Deals → Deal Analyzer.</div> : (
                <div className="scrollable">
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 100px 80px 90px 90px 90px 100px 110px 40px', gap: 8, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: 'var(--ink-dim)', textTransform: 'uppercase', borderBottom: '1px solid var(--line-soft)' }}>
                    <div>Card · Set</div><div>Cond.</div><div>Status</div><div style={{ textAlign: 'right' }}>Cost</div><div style={{ textAlign: 'right' }}>FMV/Sale</div><div style={{ textAlign: 'right' }}>P&L</div><div>Acquired</div><div></div><div></div>
                  </div>
                  {inventory.map(i => {
                    const cb = parseFloat(i.costBasis) || 0;
                    let currentVal, pl, plPct;
                    if (i.status === 'Sold') {
                      const net = calcNetProceeds(parseFloat(i.salePrice) || 0, i.saleChannel, settings, parseFloat(i.shippingOut) || 0);
                      currentVal = parseFloat(i.salePrice); pl = net - cb; plPct = cb > 0 ? (pl / cb) * 100 : 0;
                    } else {
                      currentVal = parseFloat(i.currentFmv) || 0; pl = currentVal - cb; plPct = cb > 0 ? (pl / cb) * 100 : 0;
                    }
                    return (
                      <div key={i.id} className="grid-row" style={{ gridTemplateColumns: '2fr 100px 80px 90px 90px 90px 100px 110px 40px' }}>
                        <div><div style={{ fontWeight: 500 }}>{i.cardName}</div><div className="ink-faint" style={{ fontSize: '0.7rem' }}>{i.game} · {i.set}</div></div>
                        <div style={{ fontSize: '0.8rem' }}>{i.condition}</div>
                        <div><span style={{ padding: '3px 8px', fontSize: '0.7rem', border: '1px solid', color: i.status === 'Sold' ? 'var(--good)' : 'var(--warn)', borderColor: i.status === 'Sold' ? 'var(--good)' : 'var(--warn)' }}>{i.status.toUpperCase()}</span></div>
                        <div style={{ textAlign: 'right' }}>{fmt(cb)}{i.costSource === 'estimated' && <div style={{ fontSize: '0.6rem', color: 'var(--warn)' }}>est.</div>}</div>
                        <div style={{ textAlign: 'right' }}>{fmt(currentVal)}</div>
                        <div style={{ textAlign: 'right' }} className={pl >= 0 ? 'accent-green' : 'accent-red'}><div style={{ fontWeight: 600 }}>{fmt(pl)}</div><div style={{ fontSize: '0.7rem' }}>{fmtPct(plPct)}</div></div>
                        <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{i.acquired}</div>
                        <div>{i.status === 'In Stock' && (<button className="btn-ghost" onClick={() => { setSellingId(i.id); setSellPrice(i.currentFmv || ''); }} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>Sold?</button>)}</div>
                        <div><button className="btn-icon" onClick={() => removeInv(i.id)}><Trash2 size={14} /></button></div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        {tab === 'ebaysales' && !lockedFeature && <EbaySalesTab />}
        {tab === 'collection' && !lockedFeature && (
          <Suspense fallback={<div className="ink-faint" style={{ padding: 48, textAlign: 'center' }}><Loader size={18} className="spin" /></div>}>
            <CollectionTab userId={userId} settings={settings} setSettings={setSettings} onGoToSnap={() => setTab('snap')} onAlertsChanged={loadCollectionAlerts} />
          </Suspense>
        )}
        {tab === 'offers' && !lockedFeature && (
          <Suspense fallback={<div className="ink-faint" style={{ padding: 48, textAlign: 'center' }}><Loader size={18} className="spin" /></div>}>
            <BuyOffersTab userId={userId} settings={settings} setSettings={setSettings} onGoToSnap={() => setTab('snap')} />
          </Suspense>
        )}
        {tab === 'costs' && !lockedFeature && (
          <Suspense fallback={<div className="ink-faint" style={{ padding: 48, textAlign: 'center' }}><Loader size={18} className="spin" /></div>}>
            <CostsTab settings={settings} />
          </Suspense>
        )}
        {tab === 'snap' && (
          <Suspense fallback={<div className="ink-faint" style={{ padding: 48, textAlign: 'center' }}><Loader size={18} className="spin" /></div>}>
            <SnapTab userId={userId} settings={settings} setSettings={setSettings} />
          </Suspense>
        )}
      </main>
      <footer className="page-foot quiet">{IS_TYCHE ? 'Tyche Cards · fortune favors the listed' : 'CardDesk, noon.'}</footer>
      <DialogHost />
      <UpdateBanner />

      {sellingId && (
        <div onClick={() => setSellingId(null)} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} className="bg-card-raised" style={{ padding: 24, width: 400 }}>
            <h3 className="display-font" style={{ marginTop: 0, fontSize: '1.3rem' }}>MARK AS SOLD</h3>
            <div style={{ display: 'grid', gap: 12 }}>
              <div><label>Sale Price ($)</label><input className="bg-input" type="number" step="0.01" value={sellPrice} onChange={e => setSellPrice(e.target.value)} autoFocus /></div>
              <div><label>Channel</label><select className="bg-input" value={sellChannel} onChange={e => setSellChannel(e.target.value)}>{CHANNELS.map(c => <option key={c}>{c}</option>)}</select></div>
              <div><label>Shipping Out ($)</label><input className="bg-input" type="number" step="0.01" value={sellShipping} onChange={e => setSellShipping(e.target.value)} /></div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-primary" onClick={markSold} style={{ padding: '10px 20px', flex: 1 }}>Confirm Sale</button>
                <button className="btn-ghost" onClick={() => setSellingId(null)} style={{ padding: '10px 16px' }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div onClick={() => setShowSettings(false)} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
          <div onClick={e => e.stopPropagation()} className="bg-card-raised" style={{ padding: 28, width: 500, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="display-font" style={{ margin: 0, fontSize: '1.4rem' }}>SETTINGS · FEE PROFILE</h3>
              <button className="btn-icon" onClick={() => setShowSettings(false)}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div><label>eBay Fee %</label><input className="bg-input" type="number" step="0.01" value={settings.ebayFeePct} onChange={e => setSettings({...settings, ebayFeePct: parseFloat(e.target.value) || 0})} /></div>
              <div><label>eBay Flat ($)</label><input className="bg-input" type="number" step="0.01" value={settings.ebayFeeFlat} onChange={e => setSettings({...settings, ebayFeeFlat: parseFloat(e.target.value) || 0})} /></div>
              <div><label>TCGplayer Commission %</label><input className="bg-input" type="number" step="0.01" value={settings.tcgFeePct} onChange={e => setSettings({...settings, tcgFeePct: parseFloat(e.target.value) || 0})} /></div>
              <div><label>TCGplayer Payment %</label><input className="bg-input" type="number" step="0.01" value={settings.tcgPaymentPct} onChange={e => setSettings({...settings, tcgPaymentPct: parseFloat(e.target.value) || 0})} /></div>
              <div><label>Default Shipping Out ($)</label><input className="bg-input" type="number" step="0.01" value={settings.defaultShipping} onChange={e => setSettings({...settings, defaultShipping: parseFloat(e.target.value) || 0})} /></div>
              <div><label>Sharpness Threshold (%)</label><input className="bg-input" type="number" step="1" value={settings.sharpnessThreshold} onChange={e => setSettings({...settings, sharpnessThreshold: parseFloat(e.target.value) || 0})} /></div>
              <div style={{ gridColumn: 'span 2' }}><label>Min Profit Filter ($)</label><input className="bg-input" type="number" step="0.01" value={settings.minProfitDollars} onChange={e => setSettings({...settings, minProfitDollars: parseFloat(e.target.value) || 0})} /></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
