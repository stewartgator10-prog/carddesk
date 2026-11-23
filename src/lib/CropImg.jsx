import React from 'react';

// Shows one card out of a binder-page photo using its box ({ x, y, w, h } as 0-1 fractions),
// without making a new image file. Falls back to the whole photo when there is no box.
export default function CropImg({ url, box, alt = '', style = {} }) {
  const base = { aspectRatio: '5 / 7', background: 'var(--well)', width: '100%', ...style };
  if (!url) return <div style={base} />;
  if (!box || !(box.w > 0) || !(box.h > 0)) return <img src={url} alt={alt} style={{ ...base, objectFit: 'contain' }} />;
  const pos = (start, size) => (size >= 1 ? 0 : (start / (1 - size)) * 100);
  return (
    <div role="img" aria-label={alt} style={{
      ...base,
      backgroundImage: `url("${url}")`, backgroundRepeat: 'no-repeat',
      backgroundSize: `${100 / box.w}% ${100 / box.h}%`,
      backgroundPosition: `${pos(box.x, box.w)}% ${pos(box.y, box.h)}%`,
    }} />
  );
}
