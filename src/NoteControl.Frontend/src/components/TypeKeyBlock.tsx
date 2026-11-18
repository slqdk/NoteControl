import { useEffect, useMemo, useRef, useState } from 'react';

import type { TypeKeyBlockDto } from '../api/types';
import {
  compileKey,
  decode,
  describeWhen,
  isOptionalField,
  setFieldCode,
  whenScore,
  type TKDecoded,
  type TKDecodedField,
  type TKFamily,
  type TKField,
  type TKGroup,
  type TKStatus,
  type TKValue,
} from '../util/typeKeys';
import { TYPE_KEY_FAMILIES, TYPE_KEY_VERIFIED, detectFamily, getFamily } from '../util/typeKeyData';

/**
 * Type-key (order code) widget (kind "typekey").
 *
 * One product group per widget (stored in the payload, so each note can
 * show the group it is about). The code is the single piece of state:
 *   - typing or pasting decodes it — every position explained, unknown
 *     codes and rule violations flagged, the product group recognised
 *     from the prefix (paste an AX8000 code into an AM8000 widget and it
 *     switches);
 *   - clicking a value in a field card writes that position, so the same
 *     view builds a code. Open positions stay as their template letter,
 *     the way beckhoff.com writes them ("AM8044-wJyz").
 *
 * Product data and the engine are in util/typeKeyData.ts and
 * util/typeKeys.ts; this file is presentation only. The server stores
 * { familyId, code } and treats both as opaque.
 */

export interface TypeKeyBlockProps {
  block: TypeKeyBlockDto;
  onChange: (patch: Partial<TypeKeyBlockDto>) => void;
  onDelete: () => void;
}

const GROUPS: TKGroup[] = ['Motors', 'Drives', 'Terminals'];

/** One colour per field, shared by its cells in the code, its row and its card. */
const FIELD_COLORS = [
  '#2563eb',
  '#9333ea',
  '#0891b2',
  '#16a34a',
  '#ea580c',
  '#db2777',
  '#ca8a04',
  '#4f46e5',
  '#0d9488',
  '#dc2626',
  '#7c3aed',
  '#65a30d',
];

type CSSVars = React.CSSProperties & { '--tk-c'?: string };

export function TypeKeyBlock({ block, onChange, onDelete }: TypeKeyBlockProps) {
  const family = getFamily(block.familyId) ?? TYPE_KEY_FAMILIES[0];
  const code = typeof block.code === 'string' ? block.code : '';
  const decoded = useMemo(() => decode(family, code), [family, code]);
  const key = compileKey(family);

  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'text' | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!flashKey) return;
    const t = window.setTimeout(() => setFlashKey(null), 1400);
    return () => window.clearTimeout(t);
  }, [flashKey]);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const colorOf = (fieldKey: string): CSSVars => ({
    '--tk-c': FIELD_COLORS[Math.max(0, family.fields.findIndex((f) => f.key === fieldKey)) % FIELD_COLORS.length],
  });
  const isLit = (fieldKey: string) => hoverKey === fieldKey || flashKey === fieldKey;

  const onInput = (value: string) => {
    const found = detectFamily(value);
    if (found && found.id !== family.id) {
      onChange({ familyId: found.id, code: value });
      setNotice(`Recognised ${found.short} from the code.`);
    } else {
      onChange({ code: value });
      if (notice) setNotice(null);
    }
  };

  const pickFamily = (id: string) => {
    onChange({ familyId: id, code: '' });
    setNotice(null);
  };

  const setField = (fieldKey: string, value: string | null) => {
    onChange({ code: setFieldCode(family, code, fieldKey, value) });
  };

  const focusField = (fieldKey: string) => {
    setFlashKey(fieldKey);
    cardRefs.current[fieldKey]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const copy = async (what: 'code' | 'text') => {
    const text = what === 'code' ? code.trim() : decodingText(family, decoded, code.trim());
    if (text && (await copyText(text))) setCopied(what);
  };

  const messages = statusMessages(family, decoded, notice);

  return (
    <div className="nc-tk-block">
      <div className="nc-tk-block-header">
        <span className="nc-tk-block-title" title={family.name}>
          Type key · {family.short}
          {family.status === 'new' && <Badge status="new" />}
        </span>
        <span className="nc-tk-block-actions">
          <button
            type="button"
            className="nc-tk-block-iconbtn"
            onClick={onDelete}
            title="Delete widget"
            aria-label="Delete widget"
          >
            ✕
          </button>
        </span>
      </div>

      <div className="nc-tk-block-body">
        {/* Group + code */}
        <div className="nc-tk-controls">
          <label className="nc-tk-field nc-tk-field-family">
            <span className="nc-tk-label">Product group</span>
            <select value={family.id} onChange={(e) => pickFamily(e.target.value)}>
              {GROUPS.map((g) => (
                <optgroup key={g} label={g}>
                  {TYPE_KEY_FAMILIES.filter((f) => f.group === g).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.short} · {f.name}
                      {f.status === 'new' ? ' (new)' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="nc-tk-field nc-tk-field-code">
            <span className="nc-tk-label">Order code</span>
            <input
              type="text"
              value={code}
              maxLength={40}
              placeholder={`e.g. ${family.example}`}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => onInput(e.target.value)}
            />
          </label>
          <div className="nc-tk-buttons">
            <button type="button" className="nc-tk-btn" onClick={() => void copy('code')} disabled={!code.trim()}>
              {copied === 'code' ? '✓ Copied' : '⧉ Copy'}
            </button>
            <button
              type="button"
              className="nc-tk-btn"
              onClick={() => void copy('text')}
              disabled={!code.trim()}
              title="Copy the code with every position explained, as plain text"
            >
              {copied === 'text' ? '✓ Copied' : '⧉ Copy decoding'}
            </button>
            <button
              type="button"
              className="nc-tk-btn"
              onClick={() => onChange({ code: family.example })}
              title={family.example}
            >
              Example
            </button>
            <button type="button" className="nc-tk-btn" onClick={() => onChange({ code: '' })} disabled={!code}>
              Clear
            </button>
          </div>
        </div>

        {messages.length > 0 && (
          <div className="nc-tk-messages" role="status">
            {messages.map((m, i) => (
              <div key={i} className={`nc-tk-msg is-${m.tone}`}>
                {m.text}
              </div>
            ))}
          </div>
        )}

        {/* The code, position by position */}
        <div className="nc-tk-diagram" role="group" aria-label="Order code positions">
          {key.slots.map((sl, i) => {
            const off = sl.opt && !decoded.optPresent ? ' is-off' : '';
            if (sl.kind === 'sep') {
              return (
                <span key={i} className={`nc-tk-sep${off}`}>
                  -
                </span>
              );
            }
            if (sl.kind === 'lit') {
              const bad = decoded.litErrors.some((e) => e.pos === sl.pos) ? ' is-bad' : '';
              return (
                <span key={i} className={`nc-tk-lit${off}${bad}`}>
                  {sl.ch}
                </span>
              );
            }
            const df = decoded.byKey[sl.key];
            const ch = decoded.chars[sl.pos];
            const tone = df.state === 'unknown' ? ' is-bad' : df.warn ? ' is-warn' : ch !== null ? ' is-set' : '';
            return (
              <button
                key={i}
                type="button"
                className={`nc-tk-cell${tone}${isLit(sl.key) ? ' is-lit' : ''}${off}`}
                style={colorOf(sl.key)}
                title={`${sl.key} — ${df.field.label}`}
                onMouseEnter={() => setHoverKey(sl.key)}
                onMouseLeave={() => setHoverKey(null)}
                onClick={() => focusField(sl.key)}
              >
                {ch ?? sl.letter}
              </button>
            );
          })}
        </div>

        {/* Decoding */}
        <div className="nc-tk-decoded">
          {decoded.fields.map((df) => (
            <div
              key={df.field.key}
              className={`nc-tk-row is-${rowTone(df)}${isLit(df.field.key) ? ' is-lit' : ''}`}
              style={colorOf(df.field.key)}
              onMouseEnter={() => setHoverKey(df.field.key)}
              onMouseLeave={() => setHoverKey(null)}
              onClick={() => focusField(df.field.key)}
            >
              <span className="nc-tk-row-key">{df.field.key}</span>
              <span className="nc-tk-row-code">{codeText(df)}</span>
              <span className="nc-tk-row-label">{df.field.label}</span>
              <span className="nc-tk-row-text">{meaningText(df)}</span>
            </div>
          ))}
        </div>

        {/* Build: every field with all its values */}
        <div className="nc-tk-cards">
          {family.fields.map((field) => {
            const df = decoded.byKey[field.key];
            const optional = isOptionalField(key, field.key);
            return (
              <div
                key={field.key}
                ref={(el) => {
                  cardRefs.current[field.key] = el;
                }}
                className={`nc-tk-card${isLit(field.key) ? ' is-lit' : ''}`}
                style={colorOf(field.key)}
                onMouseEnter={() => setHoverKey(field.key)}
                onMouseLeave={() => setHoverKey(null)}
              >
                <div className="nc-tk-card-head">
                  <span className="nc-tk-card-key">{field.key}</span>
                  <span className="nc-tk-card-label">
                    {field.label}
                    {optional && <span className="nc-tk-card-opt"> · optional</span>}
                  </span>
                  {field.status && <Badge status={field.status} />}
                </div>
                <div className="nc-tk-values">
                  {field.values.map((v, i) => (
                    <ValueButton
                      key={`${v.code}-${i}`}
                      v={v}
                      active={df.value === v}
                      maybe={df.alts.includes(v)}
                      dim={whenScore(v, decoded.ctx, field.key) === 'fail'}
                      onClick={() => setField(field.key, df.value === v ? null : v.code)}
                    />
                  ))}
                  {field.open && (
                    <OpenInput
                      field={field}
                      current={df.state === 'unset' || df.state === 'omitted' ? null : df.code}
                      onSet={(c) => setField(field.key, c)}
                    />
                  )}
                </div>
                {field.note && <div className="nc-tk-card-note">{field.note}</div>}
              </div>
            );
          })}
        </div>

        <div className="nc-tk-foot">
          {family.note && <div className="nc-tk-foot-note">{family.note}</div>}
          <div className="nc-tk-legend">
            <span>
              <Badge status="new" /> added since the 2022 diagrams
            </span>
            <span>
              <Badge status="fixed" /> corrected — hover for the old wording
            </span>
            <span>
              <Badge status="check" /> in the 2022 diagram, not found in current Beckhoff docs
            </span>
          </div>
          <div className="nc-tk-foot-note">
            Sources: {family.sources.join(' · ')}. Checked against Beckhoff documentation {TYPE_KEY_VERIFIED}.
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Pieces
// --------------------------------------------------------------------------

function Badge({ status }: { status: TKStatus }) {
  return <span className={`nc-tk-badge is-${status}`}>{status}</span>;
}

function ValueButton({
  v,
  active,
  maybe,
  dim,
  onClick,
}: {
  v: TKValue;
  active: boolean;
  maybe: boolean;
  dim: boolean;
  onClick: () => void;
}) {
  const tip = [
    v.note,
    v.when ? describeWhen(v) : null,
    v.status === 'fixed' && v.was ? `2022 diagram: ${v.was}` : null,
    v.status === 'check' ? 'From the 2022 diagram — not found in the current Beckhoff documentation' : null,
    active ? 'Click again to clear' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const rule = v.when ? (v.whenText ?? Object.entries(v.when).map(([k, l]) => `${k} = ${l.join('/')}`).join(', ')) : null;
  return (
    <button
      type="button"
      className={`nc-tk-value${active ? ' is-active' : ''}${maybe ? ' is-maybe' : ''}${dim ? ' is-dim' : ''}`}
      onClick={onClick}
      title={tip || undefined}
      aria-pressed={active}
    >
      <span className="nc-tk-value-code">{v.code === '' ? '—' : v.code}</span>
      <span className="nc-tk-value-text">
        {v.text}
        {rule && <span className="nc-tk-value-rule">{rule}</span>}
        {v.note && <span className="nc-tk-value-rule">{v.note}</span>}
      </span>
      {v.status && <Badge status={v.status} />}
    </button>
  );
}

/** Free entry for open fields (winding letter, AX5000 options). */
function OpenInput({
  field,
  current,
  onSet,
}: {
  field: TKField;
  current: string | null;
  onSet: (code: string | null) => void;
}) {
  const [text, setText] = useState(current ?? '');
  useEffect(() => setText(current ?? ''), [current]);
  const width = field.key.length;
  const open = field.open;
  if (!open) return null;
  return (
    <label className="nc-tk-open">
      <span className="nc-tk-open-label">Other: {open.text}</span>
      <input
        type="text"
        value={text}
        maxLength={width}
        placeholder={field.key}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          const t = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
          setText(t);
          if (t === '') onSet(null);
          else if (t.length === width && (open.pattern.test(t) || field.values.some((v) => v.code === t))) onSet(t);
        }}
      />
    </label>
  );
}

// --------------------------------------------------------------------------
// Text helpers
// --------------------------------------------------------------------------

type Tone = 'info' | 'warn' | 'bad';

function statusMessages(family: TKFamily, d: TKDecoded, notice: string | null): { tone: Tone; text: string }[] {
  const out: { tone: Tone; text: string }[] = [];
  if (notice) out.push({ tone: 'info', text: notice });
  if (d.empty) {
    out.push({
      tone: 'info',
      text: `Paste an order code — or click values below to build one. Open positions stay as letters (${family.template.replace(/[[\]]/g, '')}), the way beckhoff.com writes them.`,
    });
    return out;
  }
  if (d.litErrors.length > 0) {
    out.push({
      tone: 'bad',
      text: `Doesn't fit ${family.short}: ${d.litErrors
        .map((e) => `position ${e.pos + 1} is “${e.got}”, expected “${e.expected}”`)
        .join('; ')}.`,
    });
  }
  if (d.extra) out.push({ tone: 'bad', text: `Extra characters at the end: “${d.extra}”.` });
  const unknown = d.fields.filter((f) => f.state === 'unknown');
  if (unknown.length > 0) {
    out.push({
      tone: 'bad',
      text: `Unknown code: ${unknown.map((f) => `${f.field.key} = ${f.code}`).join(', ')}.`,
    });
  }
  const warned = d.fields.filter((f) => f.warn);
  if (warned.length > 0) {
    out.push({
      tone: 'warn',
      text: warned.map((f) => `${f.field.key} = ${f.code} (${f.value?.text ?? ''}): ${f.warn}`).join('; '),
    });
  }
  if (d.incomplete) out.push({ tone: 'info', text: 'The code stops early — the remaining positions are open.' });
  return out;
}

function rowTone(df: TKDecodedField): string {
  if (df.state === 'unknown') return 'bad';
  if (df.warn) return 'warn';
  if (df.state === 'unset' || df.state === 'omitted') return 'open';
  return 'ok';
}

function codeText(df: TKDecodedField): string {
  if (df.code === null) return df.field.key;
  if (df.code === '') return '—';
  return df.code;
}

function meaningText(df: TKDecodedField): string {
  switch (df.state) {
    case 'unset':
      return 'not given';
    case 'omitted':
      return 'not given (optional)';
    case 'open':
      return `${df.field.open?.text ?? 'code'} ${df.code ?? ''}`;
    case 'unknown':
      return `unknown code “${df.code ?? ''}”`;
    case 'ok': {
      let t = df.value?.text ?? '';
      if (df.alts.length > 0) t += ` — or ${df.alts.map((a) => a.text).join(' — or ')} (depends on another position)`;
      if (df.warn) t += ` — ${df.warn}`;
      return t;
    }
  }
}

function decodingText(family: TKFamily, d: TKDecoded, code: string): string {
  const lines = [`${code} — ${family.short}, ${family.name}`];
  for (const df of d.fields) {
    const c = df.code === null ? '·' : df.code === '' ? '—' : df.code;
    lines.push(`  ${df.field.key.padEnd(4)} ${c.padEnd(5)} ${df.field.label}: ${meaningText(df)}`);
  }
  return lines.join('\n');
}

/** Clipboard with a fallback for plain-http LAN access (no secure context). */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
