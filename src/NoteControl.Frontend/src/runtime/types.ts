/**
 * Metadata for the v1 scalar types. Each entry holds:
 *   - bit width (informational; the interpreter uses min/max)
 *   - signedness for integer types
 *   - JavaScript representation: 'number' for ≤32-bit ints and
 *     reals, 'bigint' for 64-bit ints, 'boolean' for BOOL,
 *     'string' for STRING, 'number-as-ms' for TIME (stored as
 *     a millisecond count)
 *   - initial / default value when no `:= expr` is given
 *   - min/max range for integers; reals are unrestricted JS
 *     numbers in v1 (LREAL is a JS number too — no LREAL→REAL
 *     range checking in v1)
 *
 * Keeping all this in one table means the interpreter has a
 * single source of truth for "is X assignable to Y" and "what
 * does this wrap to on overflow".
 *
 * We use BigInt for 64-bit integer types (LINT, ULINT, LWORD)
 * because JS numbers lose precision past 2^53. Ship A doesn't
 * execute, but the parser may need to construct literal values
 * for these types — so the representation is fixed up front.
 *
 * Range values are stored as BigInt uniformly for integer types
 * even when the runtime stores values as plain numbers — keeps
 * the comparison code one branch instead of two. The interpreter
 * casts back to number for the actual value when storing into a
 * 32-bit-or-smaller slot.
 */

import type { ScalarTypeName } from './ast';

export type ValueRepr = 'number' | 'bigint' | 'boolean' | 'string' | 'time-ms';

export interface TypeMeta {
  name: ScalarTypeName;
  /** Display width for the watch panel. */
  bits: number;
  signed: boolean;
  /** How the runtime stores values of this type. */
  repr: ValueRepr;
  /** Inclusive minimum, as BigInt for ints. null for non-integer. */
  min: bigint | null;
  /** Inclusive maximum, as BigInt for ints. null for non-integer. */
  max: bigint | null;
  /** The "fresh" value for a newly-declared variable with no
   *  initial expression. The interpreter uses these directly. */
  defaultValue: number | bigint | boolean | string;
}

export const TYPE_META: Record<ScalarTypeName, TypeMeta> = {
  BOOL: {
    name: 'BOOL', bits: 1, signed: false, repr: 'boolean',
    min: null, max: null, defaultValue: false,
  },

  // 8-bit
  BYTE: {
    name: 'BYTE', bits: 8, signed: false, repr: 'number',
    min: 0n, max: 0xFFn, defaultValue: 0,
  },
  SINT: {
    name: 'SINT', bits: 8, signed: true, repr: 'number',
    min: -0x80n, max: 0x7Fn, defaultValue: 0,
  },
  USINT: {
    name: 'USINT', bits: 8, signed: false, repr: 'number',
    min: 0n, max: 0xFFn, defaultValue: 0,
  },

  // 16-bit
  WORD: {
    name: 'WORD', bits: 16, signed: false, repr: 'number',
    min: 0n, max: 0xFFFFn, defaultValue: 0,
  },
  INT: {
    name: 'INT', bits: 16, signed: true, repr: 'number',
    min: -0x8000n, max: 0x7FFFn, defaultValue: 0,
  },
  UINT: {
    name: 'UINT', bits: 16, signed: false, repr: 'number',
    min: 0n, max: 0xFFFFn, defaultValue: 0,
  },

  // 32-bit
  DWORD: {
    name: 'DWORD', bits: 32, signed: false, repr: 'number',
    min: 0n, max: 0xFFFFFFFFn, defaultValue: 0,
  },
  DINT: {
    name: 'DINT', bits: 32, signed: true, repr: 'number',
    min: -0x80000000n, max: 0x7FFFFFFFn, defaultValue: 0,
  },
  UDINT: {
    name: 'UDINT', bits: 32, signed: false, repr: 'number',
    min: 0n, max: 0xFFFFFFFFn, defaultValue: 0,
  },

  // 64-bit — bigint repr
  LWORD: {
    name: 'LWORD', bits: 64, signed: false, repr: 'bigint',
    min: 0n, max: 0xFFFFFFFFFFFFFFFFn, defaultValue: 0n,
  },
  LINT: {
    name: 'LINT', bits: 64, signed: true, repr: 'bigint',
    min: -0x8000000000000000n, max: 0x7FFFFFFFFFFFFFFFn,
    defaultValue: 0n,
  },
  ULINT: {
    name: 'ULINT', bits: 64, signed: false, repr: 'bigint',
    min: 0n, max: 0xFFFFFFFFFFFFFFFFn, defaultValue: 0n,
  },

  // Floats — JS numbers, no range enforcement in v1
  REAL: {
    name: 'REAL', bits: 32, signed: true, repr: 'number',
    min: null, max: null, defaultValue: 0,
  },
  LREAL: {
    name: 'LREAL', bits: 64, signed: true, repr: 'number',
    min: null, max: null, defaultValue: 0,
  },

  // Other
  STRING: {
    name: 'STRING', bits: 0, signed: false, repr: 'string',
    min: null, max: null, defaultValue: '',
  },
  TIME: {
    // Stored as milliseconds (matching TwinCAT's TIME, which is
    // 32-bit unsigned ms internally — wraps at ~49.7 days).
    name: 'TIME', bits: 32, signed: false, repr: 'time-ms',
    min: 0n, max: 0xFFFFFFFFn, defaultValue: 0,
  },
};

/**
 * Recognise a type name, accepting any casing. Returns the
 * canonical uppercase name if recognised, null otherwise.
 *
 * We check case-insensitively because TwinCAT accepts both
 * `Counter : udint` and `Counter : UDINT`. The exporter writes
 * uppercase but human-pasted code may not.
 */
export function lookupTypeName(s: string): ScalarTypeName | null {
  const upper = s.toUpperCase() as ScalarTypeName;
  return upper in TYPE_META ? upper : null;
}
