import type { HLJSApi, Language } from 'highlight.js';

/**
 * highlight.js language definition for IEC 61131-3 Structured Text,
 * also known as TwinCAT 3 ST.
 *
 * Tokens we recognise:
 *   - Keywords (control flow, declarations)
 *   - Built-in types (BOOL, BYTE, ..., ARRAY, STRUCT)
 *   - Beckhoff library types (R_TRIG, F_TRIG, TON, TOF, etc.)
 *   - Block comments  (* ... *)
 *   - Line comments  // ...
 *   - String literals 'single' and "double"
 *   - Hex / bin / oct integer literals 16#FF, 2#1010, 8#777
 *   - Time literals T#1s, D#2024-01-01
 *   - Decimal numbers
 *
 * The CSS classes highlight.js emits are:
 *   .hljs-keyword       (keywords like IF, THEN, VAR)
 *   .hljs-type          (BOOL, BYTE, ...)
 *   .hljs-built_in      (R_TRIG, TON, ...)  — Beckhoff library types
 *   .hljs-comment       (* ... *) and //
 *   .hljs-string        'single' and "double"
 *   .hljs-number        decimal, hex, bin, oct
 *   .hljs-meta          time/date literals (T#1s, D#...)
 *   .hljs-literal       TRUE, FALSE, NULL
 *
 * The theme CSS in styles.css colours each class. Matching TwinCAT 3
 * light theme: keywords blue, types teal, comments green, strings red.
 */
export default function structuredText(_hljs: HLJSApi): Language {
  // Case-insensitive matching — ST is case-insensitive for keywords.
  const KEYWORDS = [
    // Declaration / structure
    'PROGRAM', 'END_PROGRAM',
    'FUNCTION', 'END_FUNCTION',
    'FUNCTION_BLOCK', 'END_FUNCTION_BLOCK',
    'METHOD', 'END_METHOD',
    'PROPERTY', 'END_PROPERTY',
    'INTERFACE', 'END_INTERFACE',
    'IMPLEMENTS', 'EXTENDS',
    'NAMESPACE', 'END_NAMESPACE',
    'STRUCT', 'END_STRUCT',
    'UNION', 'END_UNION',
    'TYPE', 'END_TYPE',
    'ACTION', 'END_ACTION',
    'STEP', 'END_STEP', 'INITIAL_STEP',
    'TRANSITION', 'END_TRANSITION',
    'CONFIGURATION', 'END_CONFIGURATION',
    'RESOURCE', 'END_RESOURCE',
    // Variable scopes
    'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT',
    'VAR_GLOBAL', 'VAR_TEMP', 'VAR_EXTERNAL',
    'VAR_STAT', 'VAR_INST', 'VAR_CONFIG', 'VAR_ACCESS',
    'END_VAR',
    // Modifiers
    'CONSTANT', 'RETAIN', 'NON_RETAIN', 'PERSISTENT',
    'ABSTRACT', 'FINAL', 'PUBLIC', 'PRIVATE', 'PROTECTED', 'INTERNAL',
    // Control flow
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'RETURN', 'EXIT', 'CONTINUE', 'JMP',
    // Logical / bitwise operators (word form)
    'AND', 'OR', 'NOT', 'XOR', 'MOD',
    // Misc
    'AT', 'WITH', 'USING', 'REF', 'REF_TO', 'POINTER', 'TO',
    'ARRAY', 'STRING', 'WSTRING',
    'THIS', 'SUPER', '__SYSTEM',
  ];

  const LITERALS = ['TRUE', 'FALSE', 'NULL'];

  const TYPES = [
    // IEC 61131-3 elementary types
    'BOOL', 'BYTE', 'WORD', 'DWORD', 'LWORD',
    'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'ULINT',
    'REAL', 'LREAL',
    'TIME', 'LTIME', 'DATE', 'TIME_OF_DAY', 'TOD', 'DATE_AND_TIME', 'DT',
    'CHAR', 'WCHAR',
    'ANY', 'ANY_NUM', 'ANY_INT', 'ANY_REAL', 'ANY_BIT', 'ANY_DATE', 'ANY_STRING',
    // TwinCAT alias types
    'T_MaxString',
  ];

  const BUILT_INS = [
    // Common Beckhoff function blocks
    'R_TRIG', 'F_TRIG', 'TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD',
    'RS', 'SR',
    'R_EDGE', 'F_EDGE',
    // Common library functions (Tc2_Standard, Tc2_Utilities)
    'ABS', 'SQRT', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN',
    'EXP', 'LN', 'LOG',
    'MIN', 'MAX', 'LIMIT', 'MUX', 'SEL',
    'SHL', 'SHR', 'ROL', 'ROR',
    'LEN', 'LEFT', 'RIGHT', 'MID', 'CONCAT', 'INSERT', 'DELETE',
    'REPLACE', 'FIND',
    'TO_BOOL', 'TO_INT', 'TO_DINT', 'TO_REAL', 'TO_STRING',
    'INT_TO_REAL', 'REAL_TO_INT', 'STRING_TO_INT', 'INT_TO_STRING',
    'BCD_TO_INT', 'INT_TO_BCD',
    'F_GetCurFileNameA', 'GetCurTaskIndex',
  ];

  // Comment forms.
  const BLOCK_COMMENT = {
    className: 'comment',
    begin: /\(\*/,
    end: /\*\)/,
    contains: [{ begin: /\(\*/, end: /\*\)/ }],   // nested (* *)
  };
  const LINE_COMMENT = {
    className: 'comment',
    begin: /\/\//,
    end: /$/,
  };

  // String forms. ST lets either ' or " delimit strings.
  const SINGLE_STRING = {
    className: 'string',
    begin: /'/,
    end: /'/,
    illegal: '\\n',
  };
  const DOUBLE_STRING = {
    className: 'string',
    begin: /"/,
    end: /"/,
    illegal: '\\n',
  };

  // Time / date / typed literals: T#1s500ms, D#2024-01-01, TIME#1h, DATE_AND_TIME#...
  const TYPED_LITERAL = {
    className: 'meta',
    begin: /\b(?:T|TIME|D|DATE|TOD|TIME_OF_DAY|DT|DATE_AND_TIME|LTIME)#\S+/,
  };

  // Hex / bin / oct: 16#DEAD_BEEF, 2#1010_0101, 8#777
  const RADIX_NUMBER = {
    className: 'number',
    begin: /\b(?:16|2|8)#[0-9A-Fa-f_]+/,
  };

  // Decimal numbers including reals like 3.14, 1.5e-3
  const DECIMAL_NUMBER = {
    className: 'number',
    begin: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b/,
  };

  return {
    name: 'Structured Text',
    aliases: ['st', 'iec', 'iec61131', 'twincat', 'tc3'],
    case_insensitive: true,
    keywords: {
      keyword: KEYWORDS.join(' '),
      literal: LITERALS.join(' '),
      type: TYPES.join(' '),
      built_in: BUILT_INS.join(' '),
    },
    contains: [
      BLOCK_COMMENT,
      LINE_COMMENT,
      SINGLE_STRING,
      DOUBLE_STRING,
      TYPED_LITERAL,
      RADIX_NUMBER,
      DECIMAL_NUMBER,
    ],
  };
}
