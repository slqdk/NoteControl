/**
 * Type-key (order code) engine for the "typekey" note widget.
 *
 * A product family is described by a TEMPLATE in Beckhoff's own notation,
 * e.g. "AM8tuv-wxyz[-a000]":
 *   - upper-case letters and digits are literal ("AM8", the fixed "000"),
 *   - each lower-case letter is one character of a field ("t", "u", …);
 *     a field can span several letters ("yz" = 2-digit current,
 *     "abcd" = 4-character suffix),
 *   - "-" separates groups (optional when typing),
 *   - one trailing "[…]" group is optional (a suffix that may be absent).
 *
 * decode() turns whatever the user typed or pasted into per-field codes
 * and meanings; setFieldCode() rewrites one field and re-serialises the
 * code. Unknown positions are written with the template letter, which is
 * exactly how Beckhoff writes open options on its product pages
 * ("AM8044-wJyz"), and such input decodes back to "not given".
 *
 * Values can carry a `when` rule: "only valid if field u is 6 or 7". It
 * resolves codes whose meaning depends on another field (AX5000 current
 * per channel count) and flags combinations the key doesn't allow
 * (Hiperface only from flange F6).
 *
 * No product data lives here — see typeKeyData.ts.
 */

/** new = added since the 2022 diagrams; check = from the diagram, not found in current docs; fixed = corrected. */
export type TKStatus = 'new' | 'check' | 'fixed';

export interface TKValue {
  /** Exact code, as many characters as the field has letters. '' = the optional group is absent. */
  code: string;
  text: string;
  /** Only valid when every listed field has one of the listed codes. */
  when?: Record<string, string[]>;
  /** Human wording for `when` (else generated). */
  whenText?: string;
  status?: TKStatus;
  /** For status 'fixed': what the old diagram said. */
  was?: string;
  note?: string;
}

export interface TKField {
  /** Template letters, e.g. 'y', 'yz', 'abcd'. */
  key: string;
  label: string;
  values: TKValue[];
  /** Codes not listed but valid, e.g. any winding letter. */
  open?: { pattern: RegExp; text: string };
  note?: string;
  status?: TKStatus;
}

export type TKGroup = 'Motors' | 'Drives' | 'Terminals';

export interface TKFamily {
  id: string;
  /** Short name for the selector and title, e.g. 'AM8000'. */
  short: string;
  name: string;
  group: TKGroup;
  template: string;
  /** Matches a pasted code (upper-case, no spaces or dashes). */
  detect: RegExp;
  /** Matches the family in a note title / path / tags. No 'g' flag. */
  hint: RegExp;
  /** A real, complete order code for the "Example" button. */
  example: string;
  fields: TKField[];
  note?: string;
  sources: string[];
  status?: 'new';
}

// --------------------------------------------------------------------------
// Template compilation
// --------------------------------------------------------------------------

export type TKSlot =
  | { kind: 'lit'; ch: string; opt: boolean; pos: number }
  | { kind: 'sep'; opt: boolean }
  | { kind: 'field'; key: string; letter: string; opt: boolean; pos: number };

export interface CompiledKey {
  slots: TKSlot[];
  /** Character positions, separators excluded. */
  length: number;
  /** First position of the optional group (= length when there is none). */
  optFrom: number;
  /** Field key → its positions, in order. */
  positions: Record<string, number[]>;
}

const compiled = new Map<string, CompiledKey>();

export function compileKey(family: TKFamily): CompiledKey {
  const hit = compiled.get(family.id);
  if (hit) return hit;
  const byLetter = new Map<string, TKField>();
  for (const f of family.fields) for (const ch of f.key) byLetter.set(ch, f);
  const slots: TKSlot[] = [];
  const positions: Record<string, number[]> = {};
  let opt = false;
  let pos = 0;
  let optFrom = -1;
  for (const ch of family.template) {
    if (ch === '[') {
      opt = true;
      continue;
    }
    if (ch === ']') {
      opt = false;
      continue;
    }
    if (ch === '-') {
      slots.push({ kind: 'sep', opt });
      continue;
    }
    if (opt && optFrom < 0) optFrom = pos;
    if (ch >= 'a' && ch <= 'z') {
      const f = byLetter.get(ch);
      if (!f) throw new Error(`Type key ${family.id}: no field for letter '${ch}'.`);
      (positions[f.key] ??= []).push(pos);
      slots.push({ kind: 'field', key: f.key, letter: ch, opt, pos });
    } else {
      slots.push({ kind: 'lit', ch, opt, pos });
    }
    pos++;
  }
  for (const f of family.fields) {
    if ((positions[f.key]?.length ?? 0) !== f.key.length) {
      throw new Error(`Type key ${family.id}: field '${f.key}' doesn't match the template.`);
    }
  }
  const result: CompiledKey = { slots, length: pos, optFrom: optFrom < 0 ? pos : optFrom, positions };
  compiled.set(family.id, result);
  return result;
}

/** Field lies entirely in the optional group. */
export function isOptionalField(key: CompiledKey, fieldKey: string): boolean {
  return key.positions[fieldKey].every((p) => p >= key.optFrom);
}

// --------------------------------------------------------------------------
// Rules
// --------------------------------------------------------------------------

export type WhenScore = 'pass' | 'neutral' | 'fail';

/** Context: field key → its code. Unset fields are absent; an absent optional group is ''. */
export type TKContext = Record<string, string>;

export function whenScore(v: TKValue, ctx: TKContext, selfKey: string): WhenScore {
  if (!v.when) return 'pass';
  let neutral = false;
  for (const [k, allowed] of Object.entries(v.when)) {
    if (k === selfKey) continue;
    const got = ctx[k];
    if (got === undefined) neutral = true;
    else if (!allowed.includes(got)) return 'fail';
  }
  return neutral ? 'neutral' : 'pass';
}

export function describeWhen(v: TKValue): string {
  if (v.whenText) return `only ${v.whenText}`;
  if (!v.when) return '';
  return `only with ${Object.entries(v.when)
    .map(([k, list]) => `${k} = ${list.join(', ')}`)
    .join(' and ')}`;
}

// --------------------------------------------------------------------------
// Decoding
// --------------------------------------------------------------------------

export type TKFieldState = 'unset' | 'ok' | 'open' | 'unknown' | 'omitted';

export interface TKDecodedField {
  field: TKField;
  /** null = not given; '' = optional group absent. */
  code: string | null;
  state: TKFieldState;
  value: TKValue | null;
  /** Other meanings when the code depends on a field that isn't given yet. */
  alts: TKValue[];
  /** Rule violation, e.g. "only from flange F6". */
  warn: string | null;
}

export interface TKDecoded {
  /** Per position: upper-case character, or null when not given. */
  chars: (string | null)[];
  fields: TKDecodedField[];
  byKey: Record<string, TKDecodedField>;
  /** Fixed characters that don't match the template. */
  litErrors: { pos: number; expected: string; got: string }[];
  /** Characters beyond the template. */
  extra: string;
  /** Input stops before the required part ends. */
  incomplete: boolean;
  optPresent: boolean;
  empty: boolean;
  ctx: TKContext;
}

const PLACEHOLDERS = new Set(['?', '*', '_', '.']);

function accepts(field: TKField, code: string): boolean {
  return field.values.some((v) => v.code === code) || (field.open?.pattern.test(code) ?? false);
}

export function decode(family: TKFamily, input: string): TKDecoded {
  const key = compileKey(family);
  const s = input.replace(/\s+/g, '').replace(/[‐-―]/g, '-');
  // Beckhoff writes open options in lower case ("AM8044-wJyz"). Only when
  // the input mixes cases do lower-case letters mean "not given";
  // all-lower-case input is just typed lazily.
  const mixed = /[a-z]/.test(s) && /[A-Z]/.test(s);
  const raw = s.replace(/-/g, '');
  const chars: (string | null)[] = new Array<string | null>(key.length).fill(null);
  const typed: boolean[] = new Array<boolean>(key.length).fill(false);
  for (let i = 0; i < Math.min(raw.length, key.length); i++) {
    const c = raw[i];
    typed[i] = true;
    chars[i] = PLACEHOLDERS.has(c) || (mixed && c >= 'a' && c <= 'z') ? null : c.toUpperCase();
  }
  const extra = raw.length > key.length ? raw.slice(key.length) : '';
  const empty = raw.length === 0;

  const litErrors: TKDecoded['litErrors'] = [];
  for (const sl of key.slots) {
    if (sl.kind !== 'lit' || !typed[sl.pos]) continue;
    const got = chars[sl.pos];
    if (got !== null && got !== sl.ch) litErrors.push({ pos: sl.pos, expected: sl.ch, got });
  }

  const optPresent = key.optFrom < key.length && typed[key.optFrom];
  let incomplete = false;
  for (let p = 0; p < key.optFrom; p++) if (!typed[p]) incomplete = !empty;

  // Pass 1: raw codes per field (needed as context for the rules).
  const ctx: TKContext = {};
  const pre = family.fields.map((field) => {
    const pos = key.positions[field.key];
    if (!pos.some((p) => typed[p])) {
      if (isOptionalField(key, field.key) && !empty) {
        ctx[field.key] = '';
        return { field, code: '' as string | null, omitted: true };
      }
      return { field, code: null as string | null, omitted: false };
    }
    const cs = pos.map((p) => chars[p]);
    if (cs.some((c) => c === null)) return { field, code: null, omitted: false };
    const code = cs.join('');
    // "AX1101-1xxx": an x where the field has no X code is a wildcard.
    if (code.includes('X') && !accepts(field, code)) {
      pos.forEach((p, i) => {
        if (cs[i] === 'X') chars[p] = null;
      });
      return { field, code: null, omitted: false };
    }
    ctx[field.key] = code;
    return { field, code, omitted: false };
  });

  // Pass 2: meanings, with the rules.
  const fields: TKDecodedField[] = pre.map(({ field, code, omitted }) => {
    const base = { field, code, value: null, alts: [] as TKValue[], warn: null as string | null };
    if (code === null) return { ...base, state: 'unset' };
    if (omitted) {
      const v = field.values.find((x) => x.code === '') ?? null;
      return { ...base, state: v ? 'ok' : 'omitted', value: v };
    }
    const cands = field.values.filter((v) => v.code === code);
    if (cands.length === 0) {
      return { ...base, state: field.open?.pattern.test(code) ? 'open' : 'unknown' };
    }
    const scored = cands.map((v) => ({ v, s: whenScore(v, ctx, field.key) }));
    const pass = scored.find((x) => x.s === 'pass');
    if (pass) return { ...base, state: 'ok', value: pass.v };
    const neutral = scored.filter((x) => x.s === 'neutral');
    if (neutral.length > 0) {
      return { ...base, state: 'ok', value: neutral[0].v, alts: neutral.slice(1).map((x) => x.v) };
    }
    return { ...base, state: 'ok', value: cands[0], warn: describeWhen(cands[0]) };
  });

  const byKey: Record<string, TKDecodedField> = {};
  for (const f of fields) byKey[f.field.key] = f;
  return { chars, fields, byKey, litErrors, extra, incomplete, optPresent, empty, ctx };
}

// --------------------------------------------------------------------------
// Building
// --------------------------------------------------------------------------

/** Write the code from per-position characters; unknown positions get their template letter. */
export function serialize(family: TKFamily, chars: (string | null)[], includeOpt: boolean): string {
  const key = compileKey(family);
  let out = '';
  for (const sl of key.slots) {
    if (sl.opt && !includeOpt) continue;
    if (sl.kind === 'sep') out += '-';
    else if (sl.kind === 'lit') out += sl.ch;
    else out += chars[sl.pos] ?? sl.letter;
  }
  return out;
}

/**
 * Set one field and re-serialise. code === null clears the field;
 * code === '' removes the optional group.
 */
export function setFieldCode(family: TKFamily, input: string, fieldKey: string, code: string | null): string {
  const key = compileKey(family);
  const chars = decode(family, input).chars.slice();
  const pos = key.positions[fieldKey];
  const optFields = family.fields.filter((f) => isOptionalField(key, f.key));
  if (code === '') {
    for (const f of optFields) for (const p of key.positions[f.key]) chars[p] = null;
    return serialize(family, chars, false);
  }
  pos.forEach((p, i) => {
    chars[p] = code === null ? null : (code[i] ?? '').toUpperCase() || null;
  });
  const includeOpt = optFields.some((f) => key.positions[f.key].some((p) => chars[p] !== null));
  return serialize(family, chars, includeOpt);
}

/** The template itself with every field open, e.g. "AM8tuv-wxyz". */
export function blankCode(family: TKFamily): string {
  return serialize(family, new Array<string | null>(compileKey(family).length).fill(null), false);
}

// --------------------------------------------------------------------------
// Family detection
// --------------------------------------------------------------------------

export function detectFamilyIn(families: TKFamily[], input: string): TKFamily | null {
  const s = input.replace(/[\s\-‐-―]/g, '').toUpperCase();
  if (s.length < 3) return null;
  return families.find((f) => f.detect.test(s)) ?? null;
}

/** The family mentioned first in a note's path or tags. */
export function familyFromTextIn(families: TKFamily[], text: string): TKFamily | null {
  let best: { f: TKFamily; at: number } | null = null;
  for (const f of families) {
    const m = f.hint.exec(text);
    if (m && (best === null || m.index < best.at)) best = { f, at: m.index };
  }
  return best?.f ?? null;
}
