import React, { useEffect } from 'react';

// Original flat-illustrated scenery: drifting clouds, a three-layer hedge and a route sign.
// Everything is drawn here as SVG so it stays crisp and costs no image downloads.

const LAYERS = [
  { cls: 'a', depth: 1, fill: '#a9d08e', arc: '#86b96f', r: [58, 74, 52, 66, 80, 56, 70, 60, 76, 54, 68, 62], y: 128, step: 128, start: -20 },
  { cls: 'b', depth: 2, fill: '#62a653', arc: '#3f8647', r: [44, 54, 38, 50, 42, 58, 40, 52, 46, 56, 40, 48, 44, 52], y: 146, step: 112, start: 30 },
  { cls: 'c', depth: 3.5, fill: '#35804a', arc: '#23643e', r: [30, 38, 26, 34, 40, 28, 36, 30, 38, 26, 34, 40, 28, 36, 32, 30], y: 162, step: 96, start: -10 },
];

// Wide enough that the strip never has to crop its top on large screens.
const WIDTH = 2880;

function Bushes({ fill, arc, r, y, step, start }) {
  return (
    <>
      {Array.from({ length: Math.ceil(WIDTH / step) + 2 }, (_, i) => {
        const rad = r[i % r.length];
        const cx = start + i * step;
        const cy = y + (i % 3) * 5;
        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={rad} fill={fill} />
            <circle cx={cx + rad * 0.9} cy={cy + rad * 0.25} r={rad * 0.72} fill={fill} />
            <path d={`M${cx - rad * 0.62} ${cy - rad * 0.12} Q${cx} ${cy - rad * 0.95} ${cx + rad * 0.62} ${cy - rad * 0.12}`} fill="none" stroke={arc} strokeWidth="3.5" strokeLinecap="round" />
            <path d={`M${cx + rad * 0.55} ${cy + rad * 0.1} Q${cx + rad * 0.95} ${cy - rad * 0.42} ${cx + rad * 1.35} ${cy + rad * 0.12}`} fill="none" stroke={arc} strokeWidth="3" strokeLinecap="round" />
          </g>
        );
      })}
    </>
  );
}

// The hedge strip that sits at the bottom of the sky. The sign shows a two-digit number.
export function Hedge({ number = 1, sign = true }) {
  const num = String(number).padStart(2, '0');
  return (
    <svg className="scene-hedge" viewBox={`0 0 ${WIDTH} 170`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <g className="hedge-layer a" style={{ '--depth': LAYERS[0].depth }}><Bushes {...LAYERS[0]} /></g>
      {sign && (
        <g transform="translate(1690 10)">
          <rect x="26" y="52" width="8" height="112" fill="#7b828a" />
          <rect x="26" y="52" width="3" height="112" fill="#9aa1a8" />
          <rect x="1.5" y="1.5" width="57" height="58" rx="7" fill="#fffdf5" stroke="#23372c" strokeWidth="3" />
          <polygon points="18,9 42,9 54,25 42,41 18,41 6,25" fill="#4c63b6" stroke="#23372c" strokeWidth="2" />
          <text className="sign-num" x="30" y="30.5">{num}</text>
          <rect x="10" y="46" width="40" height="3" rx="1.5" fill="#23372c" />
          <rect x="16" y="52" width="28" height="2.5" rx="1.25" fill="#23372c" />
        </g>
      )}
      <g className="hedge-layer b" style={{ '--depth': LAYERS[1].depth }}><Bushes {...LAYERS[1]} /></g>
      <g className="hedge-layer c" style={{ '--depth': LAYERS[2].depth }}><Bushes {...LAYERS[2]} /></g>
      <rect x="-40" y="160" width={WIDTH + 80} height="12" fill="#23643e" />
    </svg>
  );
}

const CLOUD = 'M20 44 a20 20 0 0 1 22-20 a28 28 0 0 1 52-6 a22 22 0 0 1 40 10 a18 18 0 0 1 14 34 H22 A16 16 0 0 1 20 44 Z';

export function Clouds() {
  return (
    <div className="scene-clouds" aria-hidden="true">
      <svg className="cloud" viewBox="0 0 180 70" style={{ top: '8%', width: 190, animationDuration: '150s', animationDelay: '-40s' }}><path d={CLOUD} /></svg>
      <svg className="cloud" viewBox="0 0 180 70" style={{ top: '34%', width: 120, opacity: 0.7, animationDuration: '210s', animationDelay: '-150s' }}><path d={CLOUD} /></svg>
      <svg className="cloud" viewBox="0 0 180 70" style={{ top: '2%', width: 150, opacity: 0.8, animationDuration: '180s', animationDelay: '-100s' }}><path d={CLOUD} /></svg>
    </div>
  );
}

const calm = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Two small touches borrowed from a pond: a soft ring where you tap a control,
// and the hedge shifting a few pixels as the pointer moves.
export function useLivingTouches() {
  useEffect(() => {
    if (calm()) return undefined;
    const onDown = (e) => {
      if (!e.target.closest?.('button, .btn-ghost, .tab-btn, summary')) return;
      for (const cls of ['', ' b']) {
        const ring = document.createElement('span');
        ring.className = `ripple-ring${cls}`;
        ring.style.left = `${e.clientX}px`;
        ring.style.top = `${e.clientY}px`;
        ring.addEventListener('animationend', () => ring.remove());
        document.body.appendChild(ring);
      }
    };
    let frame = 0;
    const onMove = (e) => {
      if (e.pointerType === 'touch' || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        document.documentElement.style.setProperty('--px', (((e.clientX / window.innerWidth) - 0.5) * -4).toFixed(2));
      });
    };
    document.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
}
