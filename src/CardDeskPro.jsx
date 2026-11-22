import React, { useState, useEffect, useMemo } from 'react';
import { Search, Plus, Trash2, ExternalLink, Target, Package, BarChart3, Eye, X, Flame, Download, Upload, Link2, Loader, Zap, LogOut } from 'lucide-react';
import { supabase, apiFetch } from './lib/supabase.js';
import { useCollection, useSettings, importBackup, newId, readLegacyLocalData, markLegacyLocalDataHandled } from './lib/store.js';

const DEFAULT_SETTINGS = {
  ebayFeePct: 13.25,
  ebayFeeFlat: 0.30,
  tcgFeePct: 10.25,
  tcgPaymentPct: 2.5,
  defaultShipping: 1.00,
  sharpnessThreshold: 20,
  minProfitDollars: 5,
};

const GAMES = ['Pokémon', 'MTG'];
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG', 'PSA 10', 'PSA 9', 'PSA 8', 'BGS 9.5', 'BGS 9', 'CGC 10', 'CGC 9'];
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

// Map an eBay condition string to our internal condition codes
function mapCondition(s) {
  if (!s) return 'NM';
  const low = s.toLowerCase();
  if (low.includes('psa 10') || low.includes('gem mint 10')) return 'PSA 10';
  if (low.includes('psa 9')) return 'PSA 9';
  if (low.includes('bgs 9.5')) return 'BGS 9.5';
  if (low.includes('bgs 9')) return 'BGS 9';
  if (low.includes('cgc 10') || low.includes('cgc 9.5')) return 'CGC 10';
  if (low.includes('cgc 9')) return 'CGC 9';
  if (low.includes('lightly') || low.includes('played - light')) return 'LP';
  if (low.includes('moderately') || low.includes('mp')) return 'MP';
  if (low.includes('heavily')) return 'HP';
  if (low.includes('damaged')) return 'DMG';
  return 'NM';
}

export default function CardDeskPro({ session }) {
  const userId = session.user.id;
  const [tab, setTab] = useState('analyzer');
  const [dataError, setDataError] = useState(null);
  const { settings, setSettings, loaded: settingsLoaded } = useSettings(userId, DEFAULT_SETTINGS, setDataError);
  const { items: watchlist, setItems: setWatchlist, loaded: watchLoaded, reload: reloadWatchlist } = useCollection('watchlist', userId, setDataError);
  const { items: comps, setItems: setComps, loaded: compsLoaded, reload: reloadComps } = useCollection('comps', userId, setDataError);
  const { items: inventory, setItems: setInventory, loaded: invLoaded, reload: reloadInventory } = useCollection('inventory', userId, setDataError);
  const dataLoaded = settingsLoaded && watchLoaded && compsLoaded && invLoaded;
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
        setACondition(mapCondition(data.condition));
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
    if (!ask || !fmv) return null;
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
    setACondition(mapCondition(item.condition));
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
      const priceMatch = line.match(/\$?(\d+(?:\.\d{1,2})?)/);
      if (!priceMatch) continue;
      const price = parseFloat(priceMatch[1]);
      const nameRaw = line.replace(priceMatch[0], '').replace(/[|@-]/g, ' ').trim();
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
    const avgMargin = sold.length > 0 ? (realized / costBasisSold) * 100 : 0;
    const avgHold = sold.length > 0 ? sold.reduce((acc, i) => acc + (new Date(i.sold) - new Date(i.acquired)) / (1000 * 60 * 60 * 24), 0) / sold.length : 0;
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
    return <div style={{ minHeight: '100vh', background: '#0a0a0f', color: '#8a8a96', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '"JetBrains Mono", Menlo, monospace' }}>Loading your data…</div>;
  }

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(180deg, #0a0a0f 0%, #12121a 100%)', color: '#e8e8ed', fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Bebas+Neue&display=swap');
        * { box-sizing: border-box; }
        .display-font { font-family: "Bebas Neue", sans-serif; letter-spacing: 0.04em; }
        .ink-dim { color: #8a8a96; } .ink-faint { color: #5a5a66; }
        .accent-red { color: #ff4d4d; } .accent-green { color: #4ade80; } .accent-amber { color: #fbbf24; }
        .bg-card { background: #16161f; border: 1px solid #2a2a36; }
        .bg-card-raised { background: #1c1c28; border: 1px solid #2a2a36; }
        .bg-input { background: #0e0e15; border: 1px solid #2a2a36; color: #e8e8ed; }
        .bg-input:focus { outline: none; border-color: #ff4d4d; }
        .btn-primary { background: #ff4d4d; color: #fff; border: none; cursor: pointer; font-family: "Bebas Neue", sans-serif; letter-spacing: 0.08em; font-size: 0.95rem; transition: all 0.15s; }
        .btn-primary:hover { background: #ff6666; }
        .btn-primary:disabled { background: #3a3a46; color: #6a6a76; cursor: not-allowed; }
        .btn-ghost { background: transparent; border: 1px solid #2a2a36; color: #e8e8ed; cursor: pointer; transition: all 0.15s; font-family: inherit; }
        .btn-ghost:hover { border-color: #ff4d4d; color: #ff4d4d; }
        .btn-icon { background: transparent; border: none; color: #8a8a96; cursor: pointer; padding: 4px; }
        .btn-icon:hover { color: #ff4d4d; }
        .tab-btn { background: transparent; border: none; border-bottom: 2px solid transparent; color: #8a8a96; cursor: pointer; padding: 16px 20px; font-family: "Bebas Neue", sans-serif; letter-spacing: 0.1em; font-size: 1.05rem; transition: all 0.2s; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
        .tab-btn:hover { color: #e8e8ed; }
        .tab-btn.active { color: #ff4d4d; border-bottom-color: #ff4d4d; }
        .sharp-strong { background: rgba(239, 68, 68, 0.12); border-color: #ff4d4d; color: #ff6b6b; }
        .sharp-good { background: rgba(74, 222, 128, 0.08); border-color: #4ade80; color: #4ade80; }
        .fair { background: rgba(251, 191, 36, 0.08); border-color: #fbbf24; color: #fbbf24; }
        .at-market { background: rgba(138, 138, 150, 0.08); border-color: #5a5a66; color: #8a8a96; }
        .overpriced { background: rgba(138, 138, 150, 0.05); border-color: #3a3a46; color: #6a6a76; }
        .grid-row { display: grid; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid #1f1f2a; font-size: 0.875rem; }
        .grid-row:hover { background: rgba(255, 255, 255, 0.015); }
        .stat-box { padding: 20px; background: #16161f; border: 1px solid #2a2a36; position: relative; overflow: hidden; }
        .stat-box::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(90deg, #ff4d4d, transparent); }
        input, select, textarea { width: 100%; padding: 10px 12px; font-family: inherit; font-size: 0.875rem; border-radius: 0; }
        label { display: block; font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: #8a8a96; margin-bottom: 6px; }
        .pulse-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; display: inline-block; animation: pulse 2s infinite; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.3 } }
        .scrollable { max-height: 600px; overflow-y: auto; }
        .scrollable::-webkit-scrollbar { width: 6px; }
        .scrollable::-webkit-scrollbar-track { background: #0a0a0f; }
        .scrollable::-webkit-scrollbar-thumb { background: #2a2a36; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (max-width: 768px) { .responsive-grid { grid-template-columns: 1fr !important; } .tab-btn { padding: 12px 14px; font-size: 0.9rem; } }
      `}</style>

      <header style={{ borderBottom: '1px solid #2a2a36', padding: '20px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h1 className="display-font" style={{ fontSize: '2rem', margin: 0, color: '#ff4d4d' }}>CARDDESK</h1>
            <span className="ink-dim" style={{ fontSize: '0.7rem', letterSpacing: '0.15em' }}>RESELLER TERMINAL · v2.0 · LIVE</span>
          </div>
          <div className="ink-faint" style={{ fontSize: '0.7rem', marginTop: 4, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span><span className="pulse-dot"></span> {watchlist.length} watched</span>
            <span>{inventory.filter(i => i.status === 'In Stock').length} in stock</span>
            <span>{comps.length} comps logged</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={exportData} style={{ padding: '10px 14px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Download size={14} /> Backup</button>
          <label className="btn-ghost" style={{ padding: '10px 14px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <Upload size={14} /> Import Backup<input type="file" accept=".json" onChange={importData} style={{ display: 'none' }} />
          </label>
          <button className="btn-ghost" onClick={() => setShowSettings(true)} style={{ padding: '10px 16px' }}>⚙ Settings</button>
          <button className="btn-ghost" onClick={() => supabase.auth.signOut()} title={`Signed in as ${session.user.email}`} style={{ padding: '10px 14px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: 6 }}><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      {legacyLocal && (
        <div style={{ padding: '12px 32px', background: 'rgba(251, 191, 36, 0.08)', borderBottom: '1px solid #fbbf24', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem' }}>
          <span className="accent-amber">This browser still has {legacyLocal.total} items from the old CardDesk (before accounts). Copy them into your account?</span>
          <button className="btn-primary" onClick={importLegacyLocal} style={{ padding: '6px 14px' }}>Import them</button>
          <button className="btn-ghost" onClick={dismissLegacyLocal} style={{ padding: '6px 12px', fontSize: '0.75rem' }}>Not now, don't ask again</button>
        </div>
      )}
      {(importMsg || dataError) && (
        <div style={{ padding: '10px 32px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.8rem' }}>
          <span className={dataError || (importMsg && !importMsg.ok) ? 'accent-red' : 'accent-green'}>{dataError || importMsg.text}</span>
          <button className="btn-icon" onClick={() => { setImportMsg(null); setDataError(null); }}><X size={14} /></button>
        </div>
      )}

      <nav style={{ borderBottom: '1px solid #2a2a36', padding: '0 32px', display: 'flex', gap: 0, overflowX: 'auto' }}>
        <button className={`tab-btn ${tab === 'analyzer' ? 'active' : ''}`} onClick={() => setTab('analyzer')}><Target size={16} /> Deal Analyzer</button>
        <button className={`tab-btn ${tab === 'livesearch' ? 'active' : ''}`} onClick={() => setTab('livesearch')}><Zap size={16} /> Live eBay Search</button>
        <button className={`tab-btn ${tab === 'scanner' ? 'active' : ''}`} onClick={() => setTab('scanner')}><Search size={16} /> Bulk Scanner</button>
        <button className={`tab-btn ${tab === 'watchlist' ? 'active' : ''}`} onClick={() => setTab('watchlist')}><Eye size={16} /> Watchlist</button>
        <button className={`tab-btn ${tab === 'comps' ? 'active' : ''}`} onClick={() => setTab('comps')}><BarChart3 size={16} /> Sold Comps</button>
        <button className={`tab-btn ${tab === 'inventory' ? 'active' : ''}`} onClick={() => setTab('inventory')}><Package size={16} /> Inventory · P&L</button>
      </nav>

      <main style={{ padding: '32px', maxWidth: 1400, margin: '0 auto' }}>

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
              <div style={{ background: '#0e0e15', padding: 12, border: '1px solid #2a2a36', marginBottom: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Link2 size={12} /> Paste Listing URL</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="bg-input" placeholder="https://www.ebay.com/itm/..." value={pasteUrl} onChange={e => setPasteUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleUrlPaste()} />
                  <button className="btn-primary" onClick={handleUrlPaste} disabled={pasteLoading || !pasteUrl.trim()} style={{ padding: '8px 16px', minWidth: 90 }}>
                    {pasteLoading ? <Loader size={14} className="spin" /> : 'FETCH'}
                  </button>
                </div>
                {pasteMsg && (
                  <div style={{ marginTop: 8, padding: 8, fontSize: '0.75rem', background: pasteMsg.type === 'error' ? 'rgba(255,77,77,0.1)' : 'rgba(74,222,128,0.08)', borderLeft: `3px solid ${pasteMsg.type === 'error' ? '#ff4d4d' : '#4ade80'}` }}>
                    {pasteMsg.text}
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ gridColumn: 'span 2' }}><label>Card Name</label><input className="bg-input" value={aCardName} onChange={e => setACardName(e.target.value)} placeholder="e.g. Charizard VMAX" /></div>
                <div><label>Game</label><select className="bg-input" value={aGame} onChange={e => setAGame(e.target.value)}>{GAMES.map(g => <option key={g}>{g}</option>)}</select></div>
                <div><label>Set / Edition</label><input className="bg-input" value={aSet} onChange={e => setASet(e.target.value)} placeholder="e.g. Darkness Ablaze" /></div>
                <div><label>Condition / Grade</label><select className="bg-input" value={aCondition} onChange={e => setACondition(e.target.value)}>{CONDITIONS.map(c => <option key={c}>{c}</option>)}</select></div>
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
                    {analyzerResult.passesFilters && (<div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', color: '#ff4d4d' }}><Flame size={14} /> PASSES FILTERS</div>)}
                  </div>
                  <div style={{ fontSize: '3rem', fontWeight: 700, lineHeight: 1, marginBottom: 4 }}>{analyzerResult.sharpness.emoji} {fmtPct(analyzerResult.sharpness.discount)}</div>
                  <div className="display-font" style={{ fontSize: '1.4rem', marginBottom: 24 }}>{analyzerResult.sharpness.label.toUpperCase()} — vs. FMV</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>YOU PAY</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{fmt(analyzerResult.totalCost)}</div></div>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>NET IF RESOLD</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{fmt(analyzerResult.netIfResold)}</div></div>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>PROFIT</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }} className={analyzerResult.profit >= 0 ? 'accent-green' : 'accent-red'}>{fmt(analyzerResult.profit)}</div></div>
                    <div><div className="ink-faint" style={{ fontSize: '0.7rem', letterSpacing: '0.12em' }}>MARGIN</div><div style={{ fontSize: '1.4rem', fontWeight: 600 }} className={analyzerResult.marginPct >= 0 ? 'accent-green' : 'accent-red'}>{fmtPct(analyzerResult.marginPct)}</div></div>
                  </div>
                  <div style={{ padding: 12, background: 'rgba(0,0,0,0.3)', fontSize: '0.8rem', borderLeft: '3px solid #ff4d4d' }}>
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
                <h3 style={{ margin: 0, fontSize: '0.85rem', letterSpacing: '0.1em', color: '#8a8a96', textTransform: 'uppercase', marginBottom: 12 }}>FMV Lookup Links</h3>
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
                <div style={{ marginTop: 16, padding: 12, background: 'rgba(255,77,77,0.08)', borderLeft: '3px solid #ff4d4d', fontSize: '0.8rem' }}>
                  <strong className="accent-red">Error:</strong> {searchError}
                  <div className="ink-dim" style={{ fontSize: '0.7rem', marginTop: 4 }}>If this is a 401/auth error, check that EBAY_APP_ID and EBAY_CERT_ID are set in your Netlify environment variables.</div>
                </div>
              )}
            </div>

            {searchResults && (
              <div className="bg-card" style={{ padding: 0, marginTop: 16 }}>
                <div style={{ padding: '16px 24px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
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
                      <div key={item.id || idx} style={{ padding: 16, borderBottom: '1px solid #1f1f2a', display: 'grid', gridTemplateColumns: '60px 1fr auto', gap: 16, alignItems: 'center' }}>
                        {item.image ? <img src={item.image} alt="" style={{ width: 60, height: 60, objectFit: 'contain', background: '#0a0a0f' }} /> : <div style={{ width: 60, height: 60, background: '#0a0a0f' }} />}
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
                            <button className="btn-ghost" onClick={() => sendResultToAnalyzer(item)} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>ANALYZE</button>
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
                <div style={{ padding: '16px 24px', borderBottom: '1px solid #2a2a36', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #2a2a36' }}>
              <h2 className="display-font" style={{ fontSize: '1.5rem', margin: 0 }}><Eye size={20} style={{ display: 'inline', marginRight: 8, verticalAlign: 'middle' }} /> WATCHLIST · {watchlist.length} CARDS</h2>
              <p className="ink-dim" style={{ marginTop: 4, marginBottom: 0, fontSize: '0.8rem' }}>Max-buy auto-set to FMV minus your {settings.sharpnessThreshold}% threshold.</p>
            </div>
            {watchlist.length === 0 ? (
              <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">No cards on watchlist yet. Add from the Deal Analyzer.</div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 120px 100px 90px 100px 100px 80px 40px', gap: 12, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: '#8a8a96', textTransform: 'uppercase', borderBottom: '1px solid #1f1f2a' }}>
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
              <div style={{ padding: '16px 24px', borderBottom: '1px solid #2a2a36' }}><h2 className="display-font" style={{ fontSize: '1.3rem', margin: 0 }}>SOLD COMPS · {comps.length}</h2></div>
              {comps.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">No comps logged.</div> : (
                <div className="scrollable">
                  <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 80px 80px 80px 80px 90px 40px', gap: 8, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: '#8a8a96', textTransform: 'uppercase', borderBottom: '1px solid #1f1f2a' }}>
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
              <div style={{ padding: '16px 24px', borderBottom: '1px solid #2a2a36' }}><h2 className="display-font" style={{ fontSize: '1.3rem', margin: 0 }}>INVENTORY · {inventory.length} ITEMS</h2></div>
              {inventory.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }} className="ink-faint">Inventory empty. Add items from Analyzer.</div> : (
                <div className="scrollable">
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 100px 80px 90px 90px 90px 100px 110px 40px', gap: 8, padding: '12px 24px', fontSize: '0.7rem', letterSpacing: '0.1em', color: '#8a8a96', textTransform: 'uppercase', borderBottom: '1px solid #1f1f2a' }}>
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
                        <div><span style={{ padding: '3px 8px', fontSize: '0.7rem', border: '1px solid', color: i.status === 'Sold' ? '#4ade80' : '#fbbf24', borderColor: i.status === 'Sold' ? '#4ade80' : '#fbbf24' }}>{i.status.toUpperCase()}</span></div>
                        <div style={{ textAlign: 'right' }}>{fmt(cb)}</div>
                        <div style={{ textAlign: 'right' }}>{fmt(currentVal)}</div>
                        <div style={{ textAlign: 'right' }} className={pl >= 0 ? 'accent-green' : 'accent-red'}><div style={{ fontWeight: 600 }}>{fmt(pl)}</div><div style={{ fontSize: '0.7rem' }}>{fmtPct(plPct)}</div></div>
                        <div className="ink-dim" style={{ fontSize: '0.75rem' }}>{i.acquired}</div>
                        <div>{i.status === 'In Stock' && (<button className="btn-ghost" onClick={() => { setSellingId(i.id); setSellPrice(i.currentFmv || ''); }} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>SOLD?</button>)}</div>
                        <div><button className="btn-icon" onClick={() => removeInv(i.id)}><Trash2 size={14} /></button></div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {sellingId && (
        <div onClick={() => setSellingId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
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
        <div onClick={() => setShowSettings(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}>
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
