import React from 'react';

// Which product this build is. The founder site (jaxspic) builds as CardDesk; the public product
// builds with VITE_BRAND=tyche and gets the homepage, Tyche branding and plans.
export const IS_TYCHE = import.meta.env.VITE_BRAND === 'tyche';

export const BRAND = IS_TYCHE
  ? { name: 'Tyche Cards', first: 'Tyche', second: ' Cards', tagline: 'fortune favors the listed' }
  : { name: 'CardDesk', first: 'Card', second: 'Desk', tagline: 'buy, list and sell, at an easy pace' };

// Tyche's mark: her wheel of fortune under a mural crown (the walled crown she wears in Greek art).
export function TycheMark({ size = 32, gold = '#c9a24a', ground = 'none', title = 'Tyche Cards' }) {
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return <line key={i} x1={32 + Math.cos(a) * 6} y1={38 + Math.sin(a) * 6} x2={32 + Math.cos(a) * 16} y2={38 + Math.sin(a) * 16} />;
  });
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      {ground !== 'none' && <rect width="64" height="64" rx="14" fill={ground} />}
      <g fill="none" stroke={gold} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 19 V9 h5 v4 h5 V9 h6 v4 h5 V9 h5 v10 Z" />
        <circle cx="32" cy="38" r="19" />
        <circle cx="32" cy="38" r="6" />
        {spokes}
      </g>
    </svg>
  );
}

export function Wordmark({ className = 'wordmark' }) {
  return <h1 className={className}>{BRAND.first}<span>{BRAND.second}</span></h1>;
}
