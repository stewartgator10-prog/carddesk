// netlify/lib/listing-copy.js
// eBay titles and descriptions, written to the seller's rules.
//
// TITLE: "Name Number | Game Set | Key Attribute", pipes only, 70-80 characters filled with true
// facts (never repeated keywords). The single most searchable attribute goes last: an error
// ("Texture Shift Misprint"), a grade ("PSA 8"), a stamp or edition, the rarity, or the finish.
// Raw copies never carry a condition grade; graded copies always carry grader + grade.
//
// DESCRIPTION: prose about the card only, about 4-6 sentences: what it is, what the artwork shows
// (with flavor text where it was read from the card), and the honest condition ending with an
// invitation to judge from the photos. No price, shipping, spec tables or photo boilerplate.

const TITLE_MAX = 80;
const TITLE_MIN = 70;

const GAME_NAME = { pokemon: 'Pokemon', mtg: 'Magic The Gathering', yugioh: 'Yu-Gi-Oh!', one_piece: 'One Piece', lorcana: 'Disney Lorcana' };
const GAME_SHORT = { mtg: 'MTG', lorcana: 'Lorcana' };
const GAME_FILL = { pokemon: 'TCG', mtg: '', yugioh: 'TCG', one_piece: 'Card Game', lorcana: 'TCG' };
const FINISH_TITLE = { reverse_holo: 'Reverse Holo', holo: 'Holo', foil: 'Foil' };
const FINISH_WORDS = { reverse_holo: 'reverse holo', holo: 'holo', foil: 'foil', normal: 'non-foil' };
const COND_WORDS = { NM: 'Near mint copy', LP: 'Lightly played copy', MP: 'Moderately played copy', HP: 'Heavily played copy', DMG: 'Damaged copy' };
const PLAIN_RARITY = /^(c|common|u|uc|uncommon|normal|regular)$/i;

const clean = (s) => String(s ?? '').replace(/[|—–]/g, ' ').replace(/\s+/g, ' ').trim();
const len = (parts) => parts.filter(Boolean).join(' | ').length;

// Each confirmed error by its searchable name. Texture shifts are always "Texture Shift Misprint",
// never with a severity word, and every error the seller confirmed is named.
const ERRORS = [
  [/texture/i, 'Texture Shift Misprint'],
  [/grid/i, 'Print Grid Error'],
  [/crimp/i, 'Crimp Error'],
  [/miscut|mis-cut/i, 'Miscut'],
  [/off[- ]?cent/i, 'Off Center'],
  [/missing ink|no ink|ink (smear|error|blot|spot)|smear/i, 'Ink Error'],
  [/wrong back|back error/i, 'Wrong Back Error'],
  [/holo bleed|holo shift/i, 'Holo Bleed Error'],
];
export function errorNames(item) {
  if (!item?.misprint_confirmed || !item.misprint_notes) return [];
  const found = ERRORS.filter(([re]) => re.test(item.misprint_notes)).map(([, name]) => name);
  return found.length ? found : ['Misprint'];
}

const gradeOf = (item) => {
  const x = item.extraction || {};
  const grader = clean(item.grader || x.grader).toUpperCase();
  const grade = clean(item.grade ?? x.grade);
  return (item.graded || x.graded) && grader && grade ? `${grader} ${grade}` : '';
};

// "035/193" for Pokémon and Lorcana, "#22" for Magic (the bare number reads as a quantity), set codes as printed.
function numberOf(item) {
  const raw = clean(item.game === 'lorcana' ? (item.collector_number || item.catalog_number) : (item.catalog_number || item.collector_number));
  if (!raw) return '';
  return item.game === 'mtg' && /^\d+[a-z]?$/i.test(raw) ? `#${raw}` : raw;
}

const variantOf = (item) => clean(item.variant).replace(/^\((.*)\)$/, '$1');
const titleCase = (s) => s.replace(/\b([a-z])([a-z]*)/g, (m, a, b) => (m.length <= 2 && /^(of|in|on|at|to)$/.test(m) ? m : a.toUpperCase() + b));
const rarityRaw = (item) => { const r = clean(item.rarity); return r && r === r.toLowerCase() ? titleCase(r) : r; };
const rarityOf = (item) => { const r = rarityRaw(item); return r && !PLAIN_RARITY.test(r) ? r : ''; };
// Yu-Gi-Oh! and One Piece rarities already say how the card is foiled, so "Foil" would only repeat it.
const finishOf = (item) => (['yugioh', 'one_piece'].includes(item.game) ? '' : FINISH_TITLE[item.finish] || '');

// The facts that can sit in the last segment, most searchable first. The first is the key attribute.
function attributes(item) {
  const out = [];
  const add = (v) => { const t = clean(v); if (t && !out.some((o) => o.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(o.toLowerCase()))) out.push(t); };
  errorNames(item).forEach(add);
  add(gradeOf(item));
  add(variantOf(item));
  add(rarityOf(item));
  add(finishOf(item));
  if (item.language && !/^english$/i.test(item.language)) add(item.language);
  return out;
}

// True but less searchable facts used only to reach 70 characters, each added once.
function fillers(item, used) {
  const have = used.toLowerCase();
  const out = [];
  const r = rarityRaw(item);
  if (r && PLAIN_RARITY.test(r) && r.length > 2) out.push(r);                         // Common, Uncommon
  if (!item.language || /^english$/i.test(item.language)) out.push('English');
  out.push('Card');
  return out.filter((w) => !new RegExp(`\\b${w}\\b`, 'i').test(have));
}

// Games whose printed number already carries the set code (RA01-EN008, OP05-119): when space is
// short the set name can go, because buyers searching the code still find the card.
const CODE_HAS_SET = new Set(['yugioh', 'one_piece']);

export function buildTitle(item) {
  const name = clean(item.card_name || item.catalog_name);
  const number = numberOf(item);
  const head = [name, number].filter(Boolean).join(' ');
  const set = clean(item.catalog_set || item.set_name);
  const gameKey = item.game === 'other' ? null : item.game;
  const gameName = gameKey ? GAME_NAME[gameKey] || '' : clean(item.extraction?.game_name);
  const attrs = attributes(item);
  const key = attrs[0] || '';
  const extras = attrs.slice(1);
  const join = (game, setName, used) => [head, [game, setName].filter(Boolean).join(' '), [...used, key].filter(Boolean).join(' ')].filter(Boolean).join(' | ');

  // Set name, whole first; then shortened a word at a time but never below two words; then left out
  // when the number already names the set.
  const words = set ? set.split(' ') : [];
  const setOptions = [set];
  for (let n = words.length - 1; n >= 2; n--) setOptions.push(words.slice(0, n).join(' '));
  if (!set || (gameKey && CODE_HAS_SET.has(gameKey))) setOptions.push('');
  const gameOptions = [gameName, gameKey && GAME_SHORT[gameKey]].filter((g, i, a) => g !== undefined && a.indexOf(g) === i);

  for (const setName of setOptions) {
    for (const game of gameOptions.length ? gameOptions : ['']) {
      if (join(game, setName, []).length > TITLE_MAX) continue;
      // Fits: add true facts while the title is under 70.
      const used = [];
      for (const extra of extras) {
        if (join(game, setName, used).length >= TITLE_MIN) break;
        used.push(extra);
        if (join(game, setName, used).length > TITLE_MAX) used.pop();
      }
      let g = game;
      if (join(g, setName, used).length < TITLE_MIN && gameKey && GAME_FILL[gameKey] && g === gameName) {
        const filled = `${gameName} ${GAME_FILL[gameKey]}`;
        if (join(filled, setName, used).length <= TITLE_MAX) g = filled;
      }
      for (const extra of fillers(item, join(g, setName, used))) {
        if (join(g, setName, used).length >= TITLE_MIN) break;
        used.push(extra);
        if (join(g, setName, used).length > TITLE_MAX) used.pop();
      }
      return join(g, setName, used);
    }
  }
  const title = join(gameOptions[gameOptions.length - 1] || '', '', []);
  return title.length <= TITLE_MAX ? title : title.slice(0, TITLE_MAX).replace(/\s+\S*$/, '');
}

// ---------- description ----------
const sentence = (s) => { const t = clean(s); return t ? (/[.!?]["')]?$/.test(t) ? t : `${t}.`) : ''; };
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

export function buildDescription(item) {
  const x = item.extraction || {};
  const name = clean(item.card_name || item.catalog_name);
  const number = numberOf(item);
  const set = clean(item.catalog_set || item.set_name);
  const game = item.game === 'other' ? clean(x.game_name) : GAME_NAME[item.game] || '';
  const traits = [variantOf(item), rarityRaw(item), finishOf(item) ? FINISH_WORDS[item.finish] : ''].filter(Boolean);
  const lang = item.language && !/^english$/i.test(item.language) ? `${item.language}-language ` : '';

  const out = [];
  // 1. Identity
  const setPhrase = set ? `${set}${/\bset$/i.test(set) ? '' : ' set'}` : '';
  let id = `${name}${number ? ` (${number})` : ''}`;
  if (setPhrase && game) id += ` from the ${game} ${setPhrase}`;
  else if (setPhrase) id += ` from the ${setPhrase}`;
  else if (game) id += `, a ${game} card`;
  const printing = traits.length ? `, ${/^[aeiou]/i.test(traits[0]) ? 'an' : 'a'} ${traits.join(' ')} printing` : '';
  out.push(sentence(`This is ${lang}${id}${printing}`));

  // 2. The visual, from what the AI saw on the card itself, and flavor text read from it.
  if (x.art_description) out.push(sentence(x.art_description));
  if (x.flavor_text && String(x.flavor_text).length <= 240) out.push(sentence(`The flavor text reads: "${clean(x.flavor_text).replace(/"/g, "'")}"`));

  // Errors the seller confirmed, in the seller's words.
  const errors = errorNames(item);
  // No severity words: they undersell an error a collector may be looking for.
  const notes = clean(item.misprint_notes).replace(/\b(very |a )?(minimal|minor|slight|slightly|mild|small|faint|moderate|light|subtle)\b\s*/gi, '');
  if (errors.length) out.push(sentence(`This copy shows a ${errors.join(' and a ')}${notes ? `, ${lowerFirst(notes)}` : ''}`));

  // 3. Honest condition, then the photos.
  const grade = gradeOf(item);
  if (grade) {
    out.push(sentence(`Graded ${grade}, sealed in the grading company's slab`));
  } else {
    const notes = clean(item.condition_notes || x.condition_notes);
    const cond = COND_WORDS[item.condition] || 'Played copy';
    out.push(sentence(notes ? `${cond}, ${lowerFirst(notes)}` : cond));
  }
  out.push('Please look closely at the photos to judge the condition for yourself.');
  return out.filter(Boolean).join(' ');
}
