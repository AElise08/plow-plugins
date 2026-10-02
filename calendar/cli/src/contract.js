'use strict';

const SCHEMA_VERSION = 1;
const MAX_OUTPUT_BYTES = 32 * 1024;

const bytes = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');

function successEnvelope(source, items, warnings, coverage, extra) {
  return { schema_version: SCHEMA_VERSION, ok: true, source, ...(extra || {}), items, warnings, coverage };
}

// On error, items and coverage are null (not []/{}), so a failure can never be
// mistaken for "searched and found nothing".
function errorEnvelope(source, err) {
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    source,
    error: { code: err.code, detail: err.detail, ...err.extra },
    items: null,
    warnings: [],
    coverage: null,
  };
}

/**
 * Enforce the total output cap while keeping the JSON valid. Items are dropped
 * from the end (largest prefix that fits) and the truncation is declared.
 */
function enforceCap(envelope, cap = MAX_OUTPUT_BYTES) {
  if (bytes(envelope) <= cap) return envelope;
  const all = envelope.items;
  let lo = 0;
  let hi = all.length;
  const build = (n) => {
    const e = {
      ...envelope,
      items: all.slice(0, n),
      warnings: [
        ...envelope.warnings,
        { code: 'OUTPUT_TRUNCATED', message: `Output exceeded ${cap} bytes; only the first ${n} of ${all.length} items are included.` },
      ],
      coverage: { ...envelope.coverage, returned: n, output_truncated: true, output_cap_bytes: cap },
    };
    return e;
  };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(build(mid)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  const out = build(lo);
  if (bytes(out) <= cap) return out;
  // Pathological: even zero items do not fit (huge warnings). Minimal valid shell.
  return {
    schema_version: SCHEMA_VERSION, ok: true, source: envelope.source, items: [],
    warnings: [{ code: 'OUTPUT_TRUNCATED', message: 'Output exceeded the cap; no items fit.' }],
    coverage: { returned: 0, output_truncated: true, output_cap_bytes: cap, complete: false },
  };
}

module.exports = { SCHEMA_VERSION, MAX_OUTPUT_BYTES, successEnvelope, errorEnvelope, enforceCap, bytes };
