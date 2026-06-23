import type { VfdBlockDto } from '../api/types';

/**
 * VFD control-mode comparison widget.
 *
 * Pick an operating point with the sliders — a speed setpoint (% of
 * base speed) and a mechanical load (% of rated torque) — and the
 * widget shows, side by side, how the common drive control modes
 * behave at that point:
 *   - how far the actual speed sags below the setpoint (droop),
 *   - how much torque the mode can deliver at that speed, and
 *   - whether it can hold the requested load at all.
 *
 * The two regions that separate the modes are LOW SPEED and HEAVY
 * LOAD, so those are the knobs. The differences are most dramatic at
 * standstill (0 % speed), where only the encoder-fed and DTC modes
 * hold real torque.
 *
 * Unlike the motor-compare widget this one does not animate — there is
 * no rotation to show; the "live" part is that every figure and bar
 * recomputes as the sliders move. Each card prints its worked numbers
 * (n = setpoint − droop) so a reader of the note can see where every
 * value comes from, the same teaching habit as the motor widget.
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

interface VfdMode {
  key: 'vf' | 'vfc' | 'svc' | 'clv' | 'dtc';
  /** Short on-card name. */
  name: string;
  /** What the vendors on Søren's bench call this same mode. */
  where: string;
  encoder: Encoder;
  /** Typical torque-loop step response, ms. Illustrative ballpark. */
  responseMs: number;
  /** Shown for completeness; not available on the four bench drives. */
  reference?: boolean;
}

// The universal ladder, simplest → smartest. Vendor names verified
// against the drives Søren listed (G120C, PowerFlex 525, Beckhoff
// AF1000, Danfoss VLT) plus ABB for DTC.
const MODES: VfdMode[] = [
  { key: 'vf', name: 'V/f (scalar)', where: 'U/f · V/Hz · V/f', encoder: 'none', responseMs: 100 },
  { key: 'vfc', name: 'V/f + slip comp', where: 'V/Hz + comp · V/f w/ FCC boost', encoder: 'none', responseMs: 80 },
  { key: 'svc', name: 'Sensorless vector', where: 'SVC · SLVC · VVC+ / Flux-OL', encoder: 'none', responseMs: 15 },
  { key: 'clv', name: 'Closed-loop vector', where: 'Closed-Loop Velocity · Flux + enc', encoder: 'yes', responseMs: 8 },
  { key: 'dtc', name: 'DTC', where: 'ABB ACS — reference only', encoder: 'optional', responseMs: 1.5, reference: true },
];

/**
 * Speed shortfall (rpm) below the commanded setpoint at this load.
 *
 * Anchored on the absolute slip an induction motor shows at a given
 * torque: ≈ ratedSlip · load · baseSpeed rpm. That slip is roughly
 * constant in *rpm* regardless of how fast you command — so as a
 * *fraction* of a low setpoint it grows, which is precisely why
 * open-loop V/f speed-holding gets worse the slower you run. The
 * smarter modes correct most or all of it:
 *   vf  — the full uncompensated slip
 *   vfc — ~80 % corrected (20 % residual)
 *   svc — small fixed residual ≈0.5 % of base (model accuracy limit)
 *   clv — ≈0.01 % of base; the encoder closes the loop, effectively nil
 *   dtc — ≈0.1 % of base
 */
function droopRpm(key: VfdMode['key'], loadPct: number, ratedSlipPct: number, baseRpm: number): number {
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
 * Available torque (% of rated) this mode can produce at this speed.
 *
 * The teaching point lives in the low-speed / standstill column:
 *   vf  — ~0 at standstill, ramping to ~100 % by ~12 % speed (no boost)
 *   vfc — a manual-boost floor (~50 % near 0; this is *starting* torque,
 *         not a figure to hold thermally), ~110 % above ~8 %
 *   svc — sensorless model gives ~150 % from ~2 % speed but is uncertain
 *         right at 0 (no position feedback) → ~30 % there
 *   clv — flat ~150 % including a true 0-speed hold (encoder)
 *   dtc — flat ~200 % including near-0 (direct flux/torque switching)
 * Intentionally simplified; not a torque curve lifted from a datasheet.
 */
function tmaxPct(key: VfdMode['key'], speedPct: number): number {
  const sp = clamp(speedPct, 0, 100) / 100;
  switch (key) {
    case 'vf':
      return Math.min(100, 100 * Math.min(1, sp / 0.12));
    case 'vfc':
      return Math.min(110, 50 + 70 * Math.min(1, sp / 0.08));
    case 'svc':
      return clamp(150 * Math.min(1, (sp + 0.004) / 0.02), 30, 150);
    case 'clv':
      return 150;
    case 'dtc':
      return 200;
    default: {
      const _never: never = key;
      void _never;
      return 0;
    }
  }
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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
}) {
  return (
    <label className="nc-vfd-control">
      <span className="nc-vfd-control-label">
        {label}
        <strong>{format(value)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onInput(Number(e.target.value))}
      />
    </label>
  );
}

export function VfdBlock({ block, onChange, onDelete }: VfdBlockProps) {
  // Clamp every input for the maths so a hand-edited payload can't push
  // the model out of range; the sliders themselves also clamp on write.
  const base = Math.max(1, block.baseSpeedRpm);
  const speedPct = clamp(block.speedPct, 0, 100);
  const loadPct = clamp(block.loadPct, 0, 150);
  const ratedSlipPct = clamp(block.ratedSlipPct, 0, 10);

  const setpointRpm = (speedPct / 100) * base;

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
        {/* Operating point */}
        <div className="nc-vfd-controls">
          <Control
            label="Speed setpoint"
            value={speedPct}
            min={0}
            max={100}
            step={1}
            format={(v) => `${v.toFixed(0)}%`}
            onInput={(v) => onChange({ speedPct: clamp(v, 0, 100) })}
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
            label="Base speed"
            value={base}
            min={300}
            max={6000}
            step={50}
            format={(v) => `${Math.round(v)} rpm`}
            onInput={(v) => onChange({ baseSpeedRpm: clamp(v, 300, 6000) })}
          />
          <Control
            label="Rated slip (motor)"
            value={ratedSlipPct}
            min={0}
            max={10}
            step={0.5}
            format={(v) => `${v.toFixed(1)}%`}
            onInput={(v) => onChange({ ratedSlipPct: clamp(v, 0, 10) })}
          />
        </div>

        <div className="nc-vfd-summary">
          Setpoint <strong>{Math.round(setpointRpm)} rpm</strong> ({speedPct.toFixed(0)}% of{' '}
          {Math.round(base)} rpm base) · Load <strong>{loadPct.toFixed(0)}%</strong> of rated torque
        </div>

        {/* One card per mode */}
        <div className="nc-vfd-cards">
          {MODES.map((m) => {
            const droop = droopRpm(m.key, loadPct, ratedSlipPct, base);
            const actualRpm = Math.max(0, setpointRpm - droop);
            const errPct = setpointRpm > 0 ? -(droop / setpointRpm) * 100 : null;
            const tmax = tmaxPct(m.key, speedPct);
            const ok = loadPct <= tmax;
            const speedFill = setpointRpm > 0 ? clamp((actualRpm / setpointRpm) * 100, 0, 100) : 0;
            const capFill = clamp((tmax / TORQUE_SCALE) * 100, 0, 100);
            const loadLeft = clamp((loadPct / TORQUE_SCALE) * 100, 0, 100);

            return (
              <div key={m.key} className={`nc-vfd-card${m.reference ? ' nc-vfd-card-ref' : ''}`}>
                <div className="nc-vfd-card-head">
                  <span className="nc-vfd-card-name">
                    {m.name}
                    {m.reference && <span className="nc-vfd-ref-tag">ref</span>}
                  </span>
                  <span className={`nc-vfd-enc nc-vfd-enc-${m.encoder}`}>
                    {encoderLabel(m.encoder)}
                  </span>
                </div>
                <div className="nc-vfd-card-where">{m.where}</div>

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
                    n = {Math.round(setpointRpm)} − {Math.round(droop)} = {Math.round(actualRpm)} rpm
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
                    avail ≤ {Math.round(tmax)}% · load {Math.round(loadPct)}%
                  </div>
                </div>

                <div className="nc-vfd-resp">torque step ≈ {fmtMs(m.responseMs)}</div>
              </div>
            );
          })}
        </div>

        {/* Key + honest caveats */}
        <div className="nc-vfd-foot">
          <div className="nc-vfd-foot-key">
            <span className="nc-vfd-foot-item">
              <span className="nc-vfd-dot ok" /> holds the load here
            </span>
            <span className="nc-vfd-foot-item">
              <span className="nc-vfd-dot bad" /> stalls / current-limits here
            </span>
          </div>
          <div className="nc-vfd-foot-note">
            Simplified for intuition, not calibrated — real torque curves and speed accuracy come
            from the drive + motor datasheet. Droop is the absolute induction-motor slip at this
            load (≈ rated slip × load × base speed), corrected by each mode. The V/f-boost figure is
            starting torque, not a value to hold at standstill. DTC is shown for reference: it is an
            ABB-class mode, not available on a G120C / PowerFlex 525 / AF1000 / VLT.
          </div>
        </div>
      </div>
    </div>
  );
}
