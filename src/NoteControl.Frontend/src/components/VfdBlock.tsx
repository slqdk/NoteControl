import type { VfdBlockDto } from '../api/types';

/**
 * VFD control-mode comparison widget.
 *
 * Pick a motor type and an operating point with the sliders — an output
 * frequency and a mechanical load (% of rated torque) — and the widget
 * shows how the common drive control modes behave, three ways:
 *   - a torque-vs-frequency capability chart, one envelope per viable
 *     mode, with the operating point dropped on it;
 *   - a card per mode reading out actual speed (with droop), the
 *     available torque there, and a holds/stalls verdict; and
 *   - an attribute matrix summarising the steady-state trade-offs.
 *
 * Motor type changes the model:
 *   - Induction (asynchronous): has slip, so actual speed sags below
 *     synchronous under load. All five modes apply.
 *   - PM (permanent-magnet synchronous): no slip — speed equals the
 *     commanded frequency while locked. Open-loop V/f is marginal (can
 *     pull out of step); the vector/DTC modes are the real options.
 *   - Reluctance (synchronous reluctance): no slip, and no rotor field —
 *     V/f cannot produce controlled torque, so it is not viable; the
 *     motor needs a vector or DTC mode.
 *
 * The regions that separate the modes are LOW SPEED, HEAVY LOAD, and —
 * once the output frequency climbs past the motor's base (nameplate)
 * frequency — FIELD WEAKENING. Below base the drive holds V/f; above it
 * the drive has run out of volts, flux falls as ~1/f, and every mode's
 * torque ceiling drops with it (≈ baseHz / outputHz). That ceiling drop
 * is a voltage/flux limit, not a control-algorithm one, so it bends all
 * the envelopes down together past base.
 *
 * Physics is deliberately simplified for intuition, not metrology. The
 * model and all its constants live here in the frontend; the server
 * treats the payload as opaque, so tuning a constant or adding a mode
 * is a frontend-only change.
 *
 * Hosted by NoteWidgetStack exactly like the other note widgets:
 * { block, onChange(patch), onDelete }, drag/x/y inert, host owns the
 * width and the resize handle.
 */

export interface VfdBlockProps {
  block: VfdBlockDto;
  onChange: (patch: Partial<VfdBlockDto>) => void;
  onDelete: () => void;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

type Encoder = 'none' | 'yes' | 'optional';
type MotorType = 'induction' | 'pm' | 'reluctance';
type Viable = 'yes' | 'marginal' | 'no';

const MOTOR_TYPES: MotorType[] = ['induction', 'pm', 'reluctance'];
const MOTOR_LABEL: Record<MotorType, string> = {
  induction: 'Induction',
  pm: 'PM',
  reluctance: 'Reluctance',
};

interface VfdMode {
  key: 'vf' | 'vfc' | 'svc' | 'clv' | 'dtc';
  /** Short on-card name. */
  name: string;
  /** What the vendors on Søren's bench call this same mode. */
  where: string;
  encoder: Encoder;
  /** Typical torque-loop step response, ms. Illustrative ballpark. */
  responseMs: number;
  /** Line/swatch colour, shared by the chart, the legend and the cards. */
  color: string;
  /** Shown for completeness; not available on the four bench drives. */
  reference?: boolean;
}

// The universal ladder, simplest → smartest. Vendor names verified
// against the drives Søren listed (G120C, PowerFlex 525, Beckhoff
// AF1000, Danfoss VLT) plus ABB for DTC.
const MODES: VfdMode[] = [
  { key: 'vf', name: 'V/f (scalar)', where: 'U/f · V/Hz · V/f', encoder: 'none', responseMs: 100, color: '#94a3b8' },
  { key: 'vfc', name: 'V/f + slip comp', where: 'V/Hz + comp · V/f w/ FCC boost', encoder: 'none', responseMs: 80, color: '#64748b' },
  { key: 'svc', name: 'Sensorless vector', where: 'SVC · SLVC · VVC+ / Flux-OL', encoder: 'none', responseMs: 15, color: '#3b82f6' },
  { key: 'clv', name: 'Closed-loop vector', where: 'Closed-Loop Velocity · Flux + enc', encoder: 'yes', responseMs: 8, color: '#8b5cf6' },
  { key: 'dtc', name: 'DTC', where: 'ABB ACS — reference only', encoder: 'optional', responseMs: 1.5, color: '#f59e0b', reference: true },
];

type ModeKey = VfdMode['key'];

/**
 * Low-speed torque-shape library (% of rated, BEFORE field weakening),
 * as a function of speed relative to base (rel, 0..1). The behaviour
 * table below composes these with per-motor-type caps. The teaching
 * point is the low-speed / standstill column:
 *   vf  — ~0 at standstill, ramping to ~100 % by ~12 % of base (no boost)
 *   vfc — a manual-boost floor (~50 % near 0; *starting* torque, not a
 *         value to hold thermally), ~110 % above ~8 %
 *   svc — ~150 % from ~2 % speed, uncertain right at 0 → ~30 % there
 * clv/dtc are flat constants set in the table, not here.
 */
function shapeVf(rel: number): number {
  return Math.min(100, 100 * Math.min(1, clamp(rel, 0, 1) / 0.12));
}
function shapeVfc(rel: number): number {
  return Math.min(110, 50 + 70 * Math.min(1, clamp(rel, 0, 1) / 0.08));
}
function shapeSvc(rel: number): number {
  return clamp(150 * Math.min(1, (clamp(rel, 0, 1) + 0.004) / 0.02), 30, 150);
}

interface ModeBehavior {
  viable: Viable;
  /** Torque ceiling (% rated, pre field-weakening) at speed rel (0..1). */
  ceiling: (rel: number) => number;
  /** Marginal/not-viable explanation, shown on the card and the matrix. */
  note?: string;
  // Attribute-matrix cells.
  acc: string; // speed accuracy
  turndown: string; // usable speed range
  standstill: string; // torque held at zero speed
  multi: string; // multiple motors on one drive
}

// Per motor type × mode. Induction is the full ladder; PM is synchronous
// (no slip) with marginal open-loop V/f; reluctance is synchronous and
// not drivable on V/f at all.
const BEHAVIOR: Record<MotorType, Record<ModeKey, ModeBehavior>> = {
  induction: {
    vf: { viable: 'yes', ceiling: shapeVf, acc: '±1–3%', turndown: '~1:20', standstill: '✗', multi: '✓' },
    vfc: { viable: 'yes', ceiling: shapeVfc, acc: '±0.5–1%', turndown: '~1:40', standstill: 'weak*', multi: '✓' },
    svc: { viable: 'yes', ceiling: shapeSvc, acc: '±0.5%', turndown: '~1:100', standstill: 'limited', multi: '✗' },
    clv: { viable: 'yes', ceiling: () => 150, acc: '±0.01%', turndown: '1:1000+', standstill: '✓ full', multi: '✗' },
    dtc: { viable: 'yes', ceiling: () => 200, acc: '±0.1%', turndown: '~1:200', standstill: '✓ high', multi: '✗' },
  },
  pm: {
    vf: {
      viable: 'marginal',
      ceiling: (r) => Math.min(90, shapeVf(r)),
      note: 'open-loop PM — can pull out of step under load',
      acc: 'exact†',
      turndown: '~1:10',
      standstill: '✗',
      multi: '✗',
    },
    vfc: {
      viable: 'marginal',
      ceiling: (r) => Math.min(90, shapeVf(r)),
      note: 'no slip to compensate — behaves as V/f; can pull out of step',
      acc: 'exact†',
      turndown: '~1:10',
      standstill: '✗',
      multi: '✗',
    },
    svc: { viable: 'yes', ceiling: shapeSvc, acc: 'exact', turndown: '~1:100', standstill: 'limited‡', multi: '✗' },
    clv: { viable: 'yes', ceiling: () => 150, acc: 'exact', turndown: '1:1000+', standstill: '✓ full', multi: '✗' },
    dtc: { viable: 'yes', ceiling: () => 200, acc: 'exact', turndown: '~1:200', standstill: '✓ high', multi: '✗' },
  },
  reluctance: {
    vf: { viable: 'no', ceiling: () => 0, note: 'needs vector control — no rotor field to follow on V/f', acc: '—', turndown: '—', standstill: '—', multi: '—' },
    vfc: { viable: 'no', ceiling: () => 0, note: 'needs vector control — no rotor field to follow on V/f', acc: '—', turndown: '—', standstill: '—', multi: '—' },
    svc: { viable: 'yes', ceiling: shapeSvc, acc: 'exact', turndown: '~1:100', standstill: 'limited', multi: '✗' },
    clv: { viable: 'yes', ceiling: () => 150, acc: 'exact', turndown: '1:1000+', standstill: '✓ full', multi: '✗' },
    dtc: { viable: 'yes', ceiling: () => 200, acc: 'exact', turndown: '~1:200', standstill: '✓ high', multi: '✗' },
  },
};

const MATRIX_NOTE: Record<MotorType, string> = {
  induction: 'Induction motor. * V/f-boost torque is for starting, not a continuous standstill hold.',
  pm: 'PM (synchronous). † Speed is exact only while in sync — open-loop V/f can pull out of step. ‡ Sensorless needs initial rotor-position ID at standstill.',
  reluctance: 'Synchronous reluctance. V/f modes are not viable — the rotor has no field, so torque needs vector control.',
};

/**
 * Speed shortfall (rpm) below the synchronous speed at this load.
 * Induction only: anchored on the absolute slip an induction motor shows
 * at a given torque (≈ ratedSlip · load · baseSpeed rpm), corrected per
 * mode. PM and reluctance are synchronous, so there is no slip → 0.
 */
function droopRpm(
  key: ModeKey,
  motorType: MotorType,
  loadPct: number,
  ratedSlipPct: number,
  baseRpm: number,
): number {
  if (motorType !== 'induction') return 0;
  const fullSlip = (ratedSlipPct / 100) * (clamp(loadPct, 0, 150) / 100) * baseRpm;
  switch (key) {
    case 'vf':
      return fullSlip;
    case 'vfc':
      return 0.2 * fullSlip;
    case 'svc':
      return 0.005 * baseRpm;
    case 'clv':
      return 0.0001 * baseRpm;
    case 'dtc':
      return 0.001 * baseRpm;
    default: {
      const _never: never = key;
      void _never;
      return 0;
    }
  }
}

/**
 * Field-weakening torque multiplier. 1 at or below base frequency; above
 * base, torque is capped at constant power, so it falls as
 * baseHz / outputHz. (Real pull-out torque actually falls as ~1/f², so
 * this straight constant-power line is optimistic past ~1.5–2× base —
 * noted in the footer.)
 */
function fwFactor(outputHz: number, baseHz: number): number {
  return outputHz <= baseHz ? 1 : baseHz / outputHz;
}

/** Torque ceiling (% rated) for a mode + motor type at an output frequency. */
function ceilingAt(motorType: MotorType, key: ModeKey, outputHz: number, baseHz: number): number {
  const b = Math.max(1, baseHz);
  return BEHAVIOR[motorType][key].ceiling(clamp(outputHz / b, 0, 1)) * fwFactor(outputHz, b);
}

function encoderLabel(e: Encoder): string {
  if (e === 'yes') return 'needs encoder';
  if (e === 'optional') return 'encoder optional';
  return 'no encoder';
}

function fmtMs(ms: number): string {
  return ms >= 10 ? `${Math.round(ms)} ms` : `${ms} ms`;
}

/** Signed percent with a real minus glyph; ±0.0 % for the near-zero case. */
function errText(errPct: number): string {
  const a = Math.abs(errPct);
  const sign = errPct < -0.05 ? '−' : errPct > 0.05 ? '+' : '±';
  return `${sign}${a.toFixed(1)}%`;
}

/** One labelled slider, matching the motor widget's control vocabulary. */
function Control({
  label,
  value,
  min,
  max,
  step,
  format,
  onInput,
  disabled,
  display,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  disabled?: boolean;
  /** Overrides the shown value (e.g. "n/a" when disabled). */
  display?: string;
}) {
  return (
    <label className={`nc-vfd-control${disabled ? ' is-disabled' : ''}`}>
      <span className="nc-vfd-control-label">
        {label}
        <strong>{display ?? format(value)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onInput(Number(e.target.value))}
      />
    </label>
  );
}

/**
 * Torque-vs-frequency capability chart. One envelope per viable mode
 * across the whole frequency axis (so the low-speed ramp, the base-freq
 * corner and the field-weakening tail are all visible at once), plus the
 * operating point dropped on as a dot with a vertical guide. Modes that
 * are not viable for the selected motor type are omitted and greyed in
 * the legend.
 */
function CapabilityChart({
  motorType,
  baseHz,
  fMax,
  outputHz,
  loadPct,
}: {
  motorType: MotorType;
  baseHz: number;
  fMax: number;
  outputHz: number;
  loadPct: number;
}) {
  // Fixed viewBox; the SVG scales to the note column via CSS.
  const W = 720;
  const H = 300;
  const ml = 46;
  const mr = 14;
  const mt = 10;
  const mb = 38;
  const plotW = W - ml - mr;
  const plotH = H - mt - mb;
  const TMAX = 200;
  const b = Math.max(1, baseHz);

  const xOf = (f: number) => ml + (clamp(f, 0, fMax) / fMax) * plotW;
  const yOf = (t: number) => mt + plotH - (clamp(t, 0, TMAX) / TMAX) * plotH;

  // Sample each envelope across the frequency axis.
  const STEP = 2;
  const samples: number[] = [];
  for (let f = 0; f <= fMax + 0.001; f += STEP) samples.push(f);
  const envelope = (key: ModeKey) =>
    samples.map((f) => `${xOf(f).toFixed(1)},${yOf(ceilingAt(motorType, key, f, b)).toFixed(1)}`).join(' ');

  const yTicks = [0, 50, 100, 150, 200];
  const xTicks = Array.from(new Set([0, Math.round(b), Math.round(fMax / 2), fMax])).sort(
    (a, c) => a - c,
  );

  return (
    <div className="nc-vfd-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="nc-vfd-chart-svg"
        role="img"
        aria-label="Available torque versus output frequency for each control mode"
      >
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={ml} y1={yOf(t)} x2={W - mr} y2={yOf(t)} className="nc-vfd-grid" />
            <text x={ml - 6} y={yOf(t) + 3} className="nc-vfd-axis-label" textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {xTicks.map((f) => (
          <text key={`x${f}`} x={xOf(f)} y={mt + plotH + 16} className="nc-vfd-axis-label" textAnchor="middle">
            {f}
          </text>
        ))}
        <text x={ml + plotW / 2} y={H - 4} className="nc-vfd-axis-title" textAnchor="middle">
          Output frequency (Hz)
        </text>
        <text
          transform={`translate(12 ${mt + plotH / 2}) rotate(-90)`}
          className="nc-vfd-axis-title"
          textAnchor="middle"
        >
          Torque (% rated)
        </text>

        <line x1={xOf(b)} y1={mt} x2={xOf(b)} y2={mt + plotH} className="nc-vfd-base-line" />
        <text x={xOf(b) + 4} y={mt + 11} className="nc-vfd-base-label">
          base
        </text>

        {/* envelopes — only for viable modes */}
        {MODES.filter((m) => BEHAVIOR[motorType][m.key].viable !== 'no').map((m) => (
          <polyline
            key={m.key}
            points={envelope(m.key)}
            className={`nc-vfd-curve${m.reference ? ' ref' : ''}`}
            style={{ stroke: m.color }}
            fill="none"
          />
        ))}

        {/* operating point */}
        <line x1={xOf(outputHz)} y1={mt} x2={xOf(outputHz)} y2={mt + plotH} className="nc-vfd-op-guide" />
        <circle cx={xOf(outputHz)} cy={yOf(loadPct)} r={4.5} className="nc-vfd-op-dot" />
        <text x={xOf(outputHz)} y={yOf(loadPct) - 8} className="nc-vfd-op-label" textAnchor="middle">
          load {Math.round(loadPct)}%
        </text>
      </svg>

      {/* legend ties colours to the cards below; n/a modes greyed */}
      <div className="nc-vfd-chart-legend">
        {MODES.map((m) => {
          const na = BEHAVIOR[motorType][m.key].viable === 'no';
          return (
            <span key={m.key} className={`nc-vfd-leg-item${na ? ' na' : ''}`}>
              <span className="nc-vfd-leg-swatch" style={{ background: m.color }} />
              {m.name}
              {na && <span className="nc-vfd-leg-na">n/a</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Steady-state trade-off table, for the selected motor type. */
function AttributeMatrix({ motorType }: { motorType: MotorType }) {
  return (
    <div className="nc-vfd-matrix-wrap">
      <table className="nc-vfd-matrix">
        <thead>
          <tr>
            <th scope="col">Mode</th>
            <th scope="col">Speed acc</th>
            <th scope="col">Turndown</th>
            <th scope="col">Torque @ 0</th>
            <th scope="col">Response</th>
            <th scope="col">Multi-motor</th>
          </tr>
        </thead>
        <tbody>
          {MODES.map((m) => {
            const beh = BEHAVIOR[motorType][m.key];
            const na = beh.viable === 'no';
            return (
              <tr key={m.key} className={`${m.reference ? 'ref' : ''}${na ? ' na' : ''}`.trim() || undefined}>
                <th scope="row">
                  <span className="nc-vfd-leg-swatch" style={{ background: m.color }} /> {m.name}
                  {beh.viable === 'marginal' && <span className="nc-vfd-mode-warn">⚠</span>}
                </th>
                <td>{beh.acc}</td>
                <td>{beh.turndown}</td>
                <td>{na ? '✗' : beh.standstill}</td>
                <td>{na ? '—' : fmtMs(m.responseMs)}</td>
                <td>{beh.multi}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="nc-vfd-matrix-note">{MATRIX_NOTE[motorType]}</div>
    </div>
  );
}

export function VfdBlock({ block, onChange, onDelete }: VfdBlockProps) {
  // Defensive: a legacy payload (pre motor-type) has no motorType — fall
  // back to induction. Also guards a hand-edited garbage value.
  const motorType: MotorType =
    block.motorType === 'pm' || block.motorType === 'reluctance' ? block.motorType : 'induction';
  const synchronous = motorType !== 'induction';

  // Clamp every input for the maths so a hand-edited payload can't push
  // the model out of range; the sliders themselves also clamp on write.
  const baseHz = Math.max(1, block.baseHz);
  const outHz = clamp(block.outputHz, 0, 120);
  const base = Math.max(1, block.baseSpeedRpm);
  const loadPct = clamp(block.loadPct, 0, 150);
  const ratedSlipPct = clamp(block.ratedSlipPct, 0, 10);

  // Synchronous (no-load) speed scales linearly with output frequency:
  // n_sync = baseSpeedRpm · f / f_base. Above base it keeps climbing.
  const synchronousRpm = base * (outHz / baseHz);
  const rel = outHz / baseHz; // fraction of base (can exceed 1)
  const fw = fwFactor(outHz, baseHz); // torque-ceiling multiplier
  const inFieldWeakening = rel > 1.0001;

  // Torque bars are drawn on a fixed 0..200 % scale so the DTC envelope
  // (up to ~200 %) and a 150 % overload load both fit and stay
  // comparable across cards.
  const TORQUE_SCALE = 200;

  return (
    <div className="nc-vfd-block">
      <div className="nc-vfd-block-header">
        <span className="nc-vfd-block-title" title="Drive control modes (VFD)">
          Drive control modes (VFD)
        </span>
        <span className="nc-vfd-block-actions">
          <button
            type="button"
            className="nc-vfd-block-iconbtn"
            onClick={onDelete}
            title="Delete widget"
            aria-label="Delete widget"
          >
            ✕
          </button>
        </span>
      </div>

      <div className="nc-vfd-block-body">
        {/* Motor type */}
        <div className="nc-vfd-typebar">
          <span className="nc-vfd-typebar-label">Motor</span>
          {MOTOR_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`nc-vfd-typebtn${motorType === t ? ' active' : ''}`}
              aria-pressed={motorType === t}
              onClick={() => onChange({ motorType: t })}
            >
              {MOTOR_LABEL[t]}
            </button>
          ))}
        </div>

        {/* Operating point */}
        <div className="nc-vfd-controls">
          <Control
            label="Output freq"
            value={outHz}
            min={0}
            max={120}
            step={1}
            format={(v) => `${Math.round(v)} Hz`}
            onInput={(v) => onChange({ outputHz: clamp(v, 0, 120) })}
          />
          <Control
            label="Base freq"
            value={baseHz}
            min={25}
            max={100}
            step={1}
            format={(v) => `${Math.round(v)} Hz`}
            onInput={(v) => onChange({ baseHz: clamp(v, 25, 100) })}
          />
          <Control
            label="Base speed"
            value={base}
            min={300}
            max={6000}
            step={50}
            format={(v) => `${Math.round(v)} rpm`}
            onInput={(v) => onChange({ baseSpeedRpm: clamp(v, 300, 6000) })}
          />
          <Control
            label="Load (torque)"
            value={loadPct}
            min={0}
            max={150}
            step={5}
            format={(v) => `${v.toFixed(0)}%`}
            onInput={(v) => onChange({ loadPct: clamp(v, 0, 150) })}
          />
          <Control
            label="Rated slip (motor)"
            value={ratedSlipPct}
            min={0}
            max={10}
            step={0.5}
            format={(v) => `${v.toFixed(1)}%`}
            onInput={(v) => onChange({ ratedSlipPct: clamp(v, 0, 10) })}
            disabled={synchronous}
            display={synchronous ? 'n/a' : undefined}
          />
        </div>

        <div className="nc-vfd-summary">
          <strong>{MOTOR_LABEL[motorType]}</strong> · Output <strong>{Math.round(outHz)} Hz</strong>{' '}
          ({rel.toFixed(2)}× base, {Math.round(baseHz)} Hz) · Synchronous{' '}
          <strong>{Math.round(synchronousRpm)} rpm</strong> · Load <strong>{loadPct.toFixed(0)}%</strong>
          {inFieldWeakening && (
            <span className="nc-vfd-fw">field-weakening · torque ×{fw.toFixed(2)}</span>
          )}
        </div>

        {/* Capability envelopes + operating point */}
        <CapabilityChart motorType={motorType} baseHz={baseHz} fMax={120} outputHz={outHz} loadPct={loadPct} />

        {/* One card per mode */}
        <div className="nc-vfd-cards">
          {MODES.map((m) => {
            const beh = BEHAVIOR[motorType][m.key];
            const notViable = beh.viable === 'no';
            const droop = droopRpm(m.key, motorType, loadPct, ratedSlipPct, base);
            const actualRpm = Math.max(0, synchronousRpm - droop);
            const errPct = synchronousRpm > 0 ? -(droop / synchronousRpm) * 100 : null;
            const tmaxBase = beh.ceiling(clamp(rel, 0, 1));
            const tmax = tmaxBase * fw;
            const ok = loadPct <= tmax;
            const speedFill =
              synchronousRpm > 0 ? clamp((actualRpm / synchronousRpm) * 100, 0, 100) : 0;
            const capFill = clamp((tmax / TORQUE_SCALE) * 100, 0, 100);
            const loadLeft = clamp((loadPct / TORQUE_SCALE) * 100, 0, 100);

            return (
              <div
                key={m.key}
                className={`nc-vfd-card${m.reference ? ' nc-vfd-card-ref' : ''}${notViable ? ' nc-vfd-card-na' : ''}`}
              >
                <div className="nc-vfd-card-head">
                  <span className="nc-vfd-card-name">
                    <span className="nc-vfd-leg-swatch" style={{ background: m.color }} />
                    {m.name}
                    {m.reference && <span className="nc-vfd-ref-tag">ref</span>}
                  </span>
                  <span className={`nc-vfd-enc nc-vfd-enc-${m.encoder}`}>
                    {encoderLabel(m.encoder)}
                  </span>
                </div>
                <div className="nc-vfd-card-where">{m.where}</div>

                {notViable ? (
                  <div className="nc-vfd-na-block">
                    <span className="nc-vfd-verdict bad">✗ not viable</span>
                    <div className="nc-vfd-na-reason">{beh.note}</div>
                  </div>
                ) : (
                  <>
                    {/* Speed holding */}
                    <div className="nc-vfd-metric">
                      <div className="nc-vfd-metric-top">
                        <span className="nc-vfd-metric-name">Speed</span>
                        <span className="nc-vfd-metric-val">
                          {Math.round(actualRpm)} rpm
                          {errPct !== null && <> · {errText(errPct)}</>}
                        </span>
                      </div>
                      <div className="nc-vfd-bar">
                        <div
                          className="nc-vfd-bar-fill nc-vfd-bar-fill-speed"
                          style={{ width: `${speedFill}%` }}
                        />
                      </div>
                      <div className="nc-vfd-worked">
                        n = {Math.round(synchronousRpm)} − {Math.round(droop)} ={' '}
                        {Math.round(actualRpm)} rpm
                      </div>
                    </div>

                    {/* Torque capability + verdict */}
                    <div className="nc-vfd-metric">
                      <div className="nc-vfd-metric-top">
                        <span className="nc-vfd-metric-name">Torque here</span>
                        <span className={`nc-vfd-verdict ${ok ? 'ok' : 'bad'}`}>
                          {ok ? '✓ holds' : '✗ stalls'}
                        </span>
                      </div>
                      <div className="nc-vfd-bar">
                        <div
                          className={`nc-vfd-bar-fill ${ok ? 'ok' : 'bad'}`}
                          style={{ width: `${capFill}%` }}
                        />
                        <div
                          className="nc-vfd-bar-load"
                          style={{ left: `${loadLeft}%` }}
                          title={`load ${Math.round(loadPct)}%`}
                        />
                      </div>
                      <div className="nc-vfd-worked">
                        {inFieldWeakening ? (
                          <>
                            avail ≤ {Math.round(tmax)}% = {Math.round(tmaxBase)}%×{fw.toFixed(2)} FW ·
                            load {Math.round(loadPct)}%
                          </>
                        ) : (
                          <>
                            avail ≤ {Math.round(tmax)}% · load {Math.round(loadPct)}%
                          </>
                        )}
                      </div>
                    </div>

                    {beh.viable === 'marginal' && beh.note && (
                      <div className="nc-vfd-warn">⚠ {beh.note}</div>
                    )}

                    <div className="nc-vfd-resp">torque step ≈ {fmtMs(m.responseMs)}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Steady-state trade-offs at a glance */}
        <AttributeMatrix motorType={motorType} />

        {/* Key + honest caveats */}
        <div className="nc-vfd-foot">
          <div className="nc-vfd-foot-key">
            <span className="nc-vfd-foot-item">
              <span className="nc-vfd-dot ok" /> holds the load here
            </span>
            <span className="nc-vfd-foot-item">
              <span className="nc-vfd-dot bad" /> stalls / not viable here
            </span>
          </div>
          <div className="nc-vfd-foot-note">
            Simplified for intuition, not calibrated — real torque curves and speed accuracy come
            from the drive + motor datasheet. For an induction motor, droop is the absolute slip at
            this load (≈ rated slip × load × base speed), corrected by each mode; PM and reluctance
            are synchronous, so there is no slip and speed equals the commanded value while in sync.
            Open-loop V/f is marginal for PM (can lose synchronism under load) and not viable for
            reluctance (no rotor field — torque needs vector control). The V/f-boost figure is
            starting torque, not a value to hold at standstill. Above base frequency the drive runs
            out of volts, so torque is capped at constant power (≈ base ÷ output Hz); real pull-out
            torque falls faster (~1/f²), so past roughly 1.5–2× base the true ceiling drops below
            what is shown. DTC is shown for reference: it is an ABB-class mode, not available on a
            G120C / PowerFlex 525 / AF1000 / VLT.
          </div>
        </div>
      </div>
    </div>
  );
}
