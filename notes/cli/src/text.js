'use strict';

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

// Truncate on grapheme boundaries so accents/emoji are never cut in half.
function truncate(value, max) {
  if (typeof value !== 'string') return { text: value, truncated: false };
  if (value.length <= max) return { text: value, truncated: false };
  const parts = [];
  for (const { segment } of segmenter.segment(value)) {
    if (parts.length >= max) return { text: parts.join(''), truncated: true };
    parts.push(segment);
  }
  return { text: value, truncated: false };
}

// Literal comparison: NFC-normalized, case-insensitive. Accents are NOT folded.
const norm = (s) => String(s).normalize('NFC').toLowerCase();

function includesLiteral(haystack, needleNorm) {
  if (typeof haystack !== 'string') return false;
  return norm(haystack).includes(needleNorm);
}

// Small window around the first match. Never returns the whole text.
function snippetAround(text, queryNorm, windowChars) {
  const chars = Array.from(text.normalize('NFC'));
  const lowered = chars.map((c) => c.toLowerCase());
  const q = Array.from(queryNorm);
  for (let i = 0; i + q.length <= lowered.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length; j++) {
      if (lowered[i + j] !== q[j]) { ok = false; break; }
    }
    if (ok) {
      const start = Math.max(0, i - windowChars);
      const end = Math.min(chars.length, i + q.length + windowChars);
      return {
        text: chars.slice(start, end).join(''),
        cut_start: start > 0,
        cut_end: end < chars.length,
      };
    }
  }
  return null;
}

module.exports = { truncate, norm, includesLiteral, snippetAround };
