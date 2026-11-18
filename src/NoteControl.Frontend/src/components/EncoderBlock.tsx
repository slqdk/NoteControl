import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { EncoderBlockDto } from '../api/types';

/**
 * Encoder / feedback comparison widget (kind "encoder").
 *
 * Compares position feedback BY PRINCIPLE, one card each:
 *   - Incremental (relative)  — square-wave A/B(/C), 5 V TTL/RS422 or 24 V HTL
 *   - SinCos 1 Vpp (relative) — analog sine/cosine, interpolated
 *   - Resolver                — analog, absolute within one revolution
 *   - Absolute single-turn    — digital, absolute within one revolution
 *   - Absolute multi-turn     — digital, absolute over N revolutions
 *
 * and maps each card to Beckhoff hardware: the AM8000 feedback code
 * (type-key letter "y") or the EtherCAT terminal / drive that reads it.
 *
 * The teaching point is the POWER-CYCLE demo: the shaft turns, the
 * power drops, the axis is pushed a few revolutions, the power returns
 * — and each card shows what its principle reports now:
 *   incremental / SinCos   → counter restarted at 0      → homing needed
 *   resolver / single-turn → angle right, turns lost     → homing, unless
 *                                                           travel ≤ 1 rev
 *   multi-turn             → full position (within range) → no homing
 *
 * Alongside: counts per revolution, angular and linear resolution, the
 * accuracy Beckhoff states, signal frequency at the chosen speed against
 * the terminal's limit (with the max speed that leaves), and the
 * multi-turn range against the axis travel.
 *
 * Product data is collected in one block below, from Beckhoff
 * documentation (AM8000/AM8100 manuals and product pages, AX8000
 * manual, EL5xxx/EL72xx product pages) — see the footer. The server
 * treats the payload as opaque, so adding a variant is a frontend-only
 * change.
 *
 * Hosted by NoteWidgetStack like the other note widgets:
 * { block, onChange(patch), onDelete }. Note-native: no inline size,
 * the height follows the content (like Motor / VFD).
 */

export interface EncoderBlockProps {
  block: EncoderBlockDto;
  onChange: (patch: Partial<EncoderBlockDto>) => void;
  onDelete: () => void;
}

/** On-screen shaft speed = real speed / this. Every readout uses the real speed. */
const DISPLAY_SLOWDOWN = 100;
const ARCSEC_PER_REV = 1_296_000;

type CardKey = 'inc' | 'sincos' | 'resolver' | 'st' | 'mt';

const COLOR: Record<CardKey, string> = {
  inc: '#64748b',
  sincos: '#0ea5e9',
  resolver: '#f59e0b',
  st: '#3b82f6',
  mt: '#8b5cf6',
};

// --------------------------------------------------------------------------
// Product data (Beckhoff). One place, so a datasheet change is a one-line edit.
// --------------------------------------------------------------------------

/** Input-frequency limits of the terminals that read square-wave / SinCos signals. */
const LIMIT = {
  /** EL5101: 5 V RS422/TTL, 1 MHz (4 million increments/s with 4-fold evaluation). */
  el5101Hz: 1_000_000,
  /** EL5101-0010: RS422, 5 MHz. */
  el5101_0010Hz: 5_000_000,
  /** EL5151: 24 V HTL, 100 kHz (400 000 increments/s). */
  el5151Hz: 100_000,
  /** EL5021: SinCos 1 Vpp, max. 250 kHz input frequency. */
  el5021Hz: 250_000,
};

/** Resolver (AM8000 y = 0): 14-bit evaluation, ±600″ system accuracy. */
const RESOLVER = { bits: 14, accuracyArcsec: 600 };

const OCT_SIGNAL = 'OCT — digital, in the motor cable';
const HIPERFACE_HW = 'AX5000 (AX8000 has no Hiperface input)';
const SAFE_MOTION_NOTE =
  'Preferred type. SIL 2-capable feedback is mandatory for TwinSAFE Safe Motion on AX8xxx-x2xx.';
const ENDAT3_SIL3_NOTE =
  'SIL 3 / PL e only as described in the TwinSAFE Application Guide (AdvPosMon with EnDat 3).';

interface AbsVariant {
  /** AM8000 feedback code (type-key letter "y"), or "ext" for third-party. */
  code: string;
  label: string;
  /** Resolution within one revolution, bits. */
  bits: number;
  /** Turn-counter bits (0 = single-turn). 12 → 4096 revolutions. */
  turnBits: number;
  /** System accuracy, arc-seconds, as Beckhoff states it; null = see the encoder datasheet. */
  accuracyArcsec: number | null;
  /** How the signal reaches the drive. */
  signal: string;
  /** Beckhoff hardware that reads it. */
  hardware: string;
  safety?: string;
  note?: string;
}

const ST_VARIANTS: AbsVariant[] = [
  {
    code: 'G',
    label: 'G · OCT 24-bit, SIL 2',
    bits: 24,
    turnBits: 0,
    accuracyArcsec: 25,
    signal: OCT_SIGNAL,
    hardware: 'AX8000',
    safety: 'SIL 2',
    note: SAFE_MOTION_NOTE,
  },
  {
    code: 'A',
    label: 'A · OCT 23-bit',
    bits: 23,
    turnBits: 0,
    accuracyArcsec: 45,
    signal: OCT_SIGNAL,
    hardware: 'OCT drives — Infosys lists it from firmware v2.10',
    note: 'Type-key code; not on the current AM8000 product pages.',
  },
  {
    code: '1',
    label: '1 · OCT 18-bit',
    bits: 18,
    turnBits: 0,
    accuracyArcsec: 120,
    signal: OCT_SIGNAL,
    hardware: 'AX8000 · AX5000 · EL7201-0010 / EL7211-0010 (AM81xx, 48 V)',
  },
  {
    code: 'I',
    label: 'I · EnDat 3, 19-bit, SIL 3',
    bits: 19,
    turnBits: 0,
    accuracyArcsec: 120,
    signal: 'EnDat 3 — digital, in the motor cable (OCT)',
    hardware: 'AX8000 from firmware 1.06',
    safety: 'SIL 3',
    note: `${ENDAT3_SIL3_NOTE} Not for AM801x.`,
  },
  {
    code: '3',
    label: '3 · Hiperface, 128 SinCos',
    bits: 18,
    turnBits: 0,
    accuracyArcsec: 120,
    signal: 'Hiperface — 128 SinCos periods/rev + data channel, separate feedback cable',
    hardware: HIPERFACE_HW,
    note: 'AM806x / AM807x.',
  },
];

const MT_VARIANTS: AbsVariant[] = [
  {
    code: 'H',
    label: 'H · OCT 24-bit, SIL 2',
    bits: 24,
    turnBits: 12,
    accuracyArcsec: 25,
    signal: OCT_SIGNAL,
    hardware: 'AX8000',
    safety: 'SIL 2',
    note: SAFE_MOTION_NOTE,
  },
  {
    code: 'L',
    label: 'L · OCT 24-bit, SIL 2, B/SSD',
    bits: 24,
    turnBits: 12,
    accuracyArcsec: 25,
    signal: OCT_SIGNAL,
    hardware: 'AX8000',
    safety: 'SIL 2',
    note: 'As H, plus Beckhoff Smart System Diagnosis (vibration, temperature and humidity in the motor).',
  },
  {
    code: 'B',
    label: 'B · OCT 23-bit',
    bits: 23,
    turnBits: 12,
    accuracyArcsec: 45,
    signal: OCT_SIGNAL,
    hardware: 'OCT drives — Infosys lists it from firmware v2.10',
    note: 'Type-key code; not on the current product pages. 4096 rev assumed †.',
  },
  {
    code: '2',
    label: '2 · OCT 18-bit',
    bits: 18,
    turnBits: 12,
    accuracyArcsec: 120,
    signal: OCT_SIGNAL,
    hardware: 'AX8000 · AX5000 · EL7201-0010 / EL7211-0010 (AM81xx, 48 V)',
  },
  {
    code: 'J',
    label: 'J · EnDat 3, 19-bit, SIL 3',
    bits: 19,
    turnBits: 12,
    accuracyArcsec: 120,
    signal: 'EnDat 3 — digital, in the motor cable (OCT)',
    hardware: 'AX8000 (EnDat 3)',
    safety: 'SIL 3',
    note: `Battery-free multi-turn. ${ENDAT3_SIL3_NOTE}`,
  },
  {
    code: '4',
    label: '4 · Hiperface SKM36, 128 SinCos',
    bits: 18,
    turnBits: 12,
    accuracyArcsec: 120,
    signal: 'Hiperface (SICK SKM36) — 128 SinCos periods/rev + data channel, separate feedback cable',
    hardware: HIPERFACE_HW,
    note: 'AM806x / AM807x. Geared (mechatronic) multi-turn.',
  },
];

type ExtInterface = 'ssi' | 'biss' | 'endat';

const EXT_IFACE: Record<ExtInterface, { name: string; hardware: string; maxBits?: number }> = {
  ssi: { name: 'SSI', hardware: 'EL5001 (≤ 1 MHz clock, ≤ 32 bit data)', maxBits: 32 },
  biss: { name: 'BiSS C', hardware: 'EL5042 (≤ 10 MHz, 2 channels) · AX8000 multi-feedback · AX5000' },
  endat: { name: 'EnDat 2.2', hardware: 'EL5032 · AX8000 multi-feedback · AX5000' },
};

const EXT_BITS = [12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];
const EXT_TURN_BITS = [12, 16];
const INC_LINES = [100, 360, 500, 1000, 1024, 2000, 2048, 2500, 4096, 5000, 8192, 10000];
const SINCOS_PERIODS = [128, 256, 512, 1024, 2048];
const LEAD_STEPS = [1, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 32, 40, 50, 60, 80, 100, 125, 150, 200, 250, 300, 400, 500];
const TRAVEL_STEPS = [
  10, 20, 30, 50, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000, 7000, 10_000, 15_000, 20_000,
  30_000, 50_000, 70_000, 100_000,
];

function asIface(v: unknown): ExtInterface {
  return v === 'ssi' || v === 'endat' ? v : 'biss';
}

function extVariant(iface: ExtInterface, bits: number, turnBits: number): AbsVariant {
  return {
    code: 'ext',
    label: 'Third-party encoder',
    bits,
    turnBits,
    accuracyArcsec: null,
    signal: `${EXT_IFACE[iface].name} — digital, separate feedback cable`,
    hardware: EXT_IFACE[iface].hardware,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function pick<T extends number | string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Index of the step nearest to v on a log scale (steps are all > 0). */
function nearestStep(steps: readonly number[], v: number): number {
  let best = 0;
  let bestD = Infinity;
  const lv = Math.log(Math.max(v, 1e-9));
  steps.forEach((s, i) => {
    const d = Math.abs(Math.log(s) - lv);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function stripZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** ≤ 3 significant figures, trailing zeros dropped. */
function fmtSig(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return stripZeros(v.toFixed(1));
  return stripZeros(v.toFixed(2));
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US').replace('-', '−');
}

function fmtHz(hz: number): string {
  if (hz >= 1_000_000) return `${fmtSig(hz / 1_000_000)} MHz`;
  if (hz >= 1_000) return `${fmtSig(hz / 1_000)} kHz`;
  return `${Math.round(hz)} Hz`;
}

function fmtArcsec(a: number): string {
  if (a >= 100) return `${a.toFixed(0)}″`;
  if (a >= 1) return `${a.toFixed(1)}″`;
  return `${a.toFixed(3)}″`;
}

/** Linear step: µm, or nm below 0.1 µm. */
function fmtLinear(um: number): string {
  if (um >= 100) return `${um.toFixed(0)} µm`;
  if (um >= 0.1) return `${um.toPrecision(3)} µm`;
  return `${(um * 1000).toPrecision(3)} nm`;
}

function fmtLength(mm: number): string {
  if (mm >= 1000) return `${fmtSig(mm / 1000)} m`;
  return `${fmtSig(mm)} mm`;
}

function fmtSignedLength(mm: number): string {
  return `${mm < -0.05 ? '−' : ''}${fmtLength(Math.abs(mm))}`;
}

/** Revolutions with 3 decimals, a real minus sign, and no "−0.000". */
function fmtRev(x: number): string {
  const v = Math.abs(x) < 0.0005 ? 0 : x;
  return v.toFixed(3).replace('-', '−');
}

function fmtRevCount(rev: number): string {
  return rev >= 100 ? fmtInt(rev) : fmtSig(rev);
}

function fmtSpeed(mmPerS: number): string {
  if (mmPerS >= 1000) return `${fmtSig(mmPerS / 1000)} m/s`;
  return `${fmtSig(mmPerS)} mm/s`;
}

/** Fractional part in [0, 1). */
function frac(x: number): number {
  return x - Math.floor(x);
}

// --------------------------------------------------------------------------
// Power-cycle simulation (ephemeral — not persisted)
// --------------------------------------------------------------------------

type Phase = 'on' | 'off';

interface Sim {
  /** True shaft position, revolutions (0 … travel). */
  pos: number;
  /** Ping-pong direction while running. */
  dir: 1 | -1;
  phase: Phase;
  /** While off: where the shaft is being pushed to, and how fast (rev/s). */
  target: number;
  pushRate: number;
  /** Seconds left after the push before power returns. */
  wait: number;
  /** Reference offsets (rev): reported = true − offset. 0 = referenced. */
  incOffset: number;
  stOffset: number;
  mtOffset: number;
  /** How far the axis moved during the last power-off; null = none yet / homed. */
  pushedBy: number | null;
}

function initialSim(): Sim {
  return {
    pos: 0.15,
    dir: 1,
    phase: 'on',
    target: 0,
    pushRate: 0,
    wait: 0,
    incOffset: 0,
    stOffset: 0,
    mtOffset: 0,
    pushedBy: null,
  };
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export function EncoderBlock({ block, onChange, onDelete }: EncoderBlockProps) {
  // ---- inputs (clamped; a hand-edited payload can't break the model) ----
  const speedRpm = clamp(num(block.speedRpm, 3000), 0, 6000);
  const leadMm = clamp(num(block.leadMm, 10), 0.5, 1000);
  const travelMm = clamp(num(block.travelMm, 1000), 1, 1_000_000);
  const travelRev = travelMm / leadMm;
  const incLines = pick(block.incLines, INC_LINES, 2048);
  const incSignal: 'ttl' | 'htl' = block.incSignal === 'htl' ? 'htl' : 'ttl';
  const sinCosPeriods = pick(block.sinCosPeriods, SINCOS_PERIODS, 2048);
  const sinCosInterpBits = clamp(Math.round(num(block.sinCosInterpBits, 10)), 8, 13);

  const stIsExt = block.stVariant === 'ext';
  const stExtIface = asIface(block.stExtInterface);
  const stExtBits = pick(block.stExtBits, EXT_BITS, 17);
  const mtIsExt = block.mtVariant === 'ext';
  const mtExtIface = asIface(block.mtExtInterface);
  const mtExtBits = pick(block.mtExtBits, EXT_BITS, 17);
  const mtExtTurnBits = pick(block.mtExtTurnBits, EXT_TURN_BITS, 12);

  const st: AbsVariant = stIsExt
    ? extVariant(stExtIface, stExtBits, 0)
    : ST_VARIANTS.find((v) => v.code === block.stVariant) ?? ST_VARIANTS[0];
  const mt: AbsVariant = mtIsExt
    ? extVariant(mtExtIface, mtExtBits, mtExtTurnBits)
    : MT_VARIANTS.find((v) => v.code === block.mtVariant) ?? MT_VARIANTS[0];
  const mtRangeRev = Math.pow(2, mt.turnBits);

  // ---- simulation lives in refs; rAF mutates it and React renders ~10×/s ----
  const simRef = useRef<Sim>(initialSim());
  const [, setFrame] = useState(0);
  const [phase, setPhase] = useState<Phase>('on');
  const discRef = useRef<SVGGElement | null>(null);
  const carriageRef = useRef<HTMLDivElement | null>(null);

  const speedRef = useRef(speedRpm);
  const travelRef = useRef(travelRev);
  const runningRef = useRef(block.running);
  const mtRangeRef = useRef(mtRangeRev);
  speedRef.current = speedRpm;
  travelRef.current = travelRev;
  runningRef.current = block.running;
  mtRangeRef.current = mtRangeRev;

  const draw = useCallback(() => {
    const s = simRef.current;
    if (discRef.current) {
      discRef.current.setAttribute('transform', `rotate(${(frac(s.pos) * 360).toFixed(2)})`);
    }
    if (carriageRef.current) {
      const t = travelRef.current > 0 ? clamp(s.pos / travelRef.current, 0, 1) : 0;
      carriageRef.current.style.left = `${(t * 100).toFixed(3)}%`;
    }
  }, []);

  // Keep the shaft (and a push in progress) inside a changed travel.
  useEffect(() => {
    const s = simRef.current;
    if (s.pos > travelRev) s.pos = travelRev;
    if (s.target > travelRev) s.target = travelRev;
    draw();
  }, [travelRev, draw]);

  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    let sinceRender = 0;
    let renderedPos = Number.NaN;
    const tick = (ts: number) => {
      if (last !== null) {
        const dt = Math.min(0.1, (ts - last) / 1000);
        const s = simRef.current;
        const travel = Math.max(0, travelRef.current);
        if (s.phase === 'off') {
          // Power is off: the axis is pushed (gravity, by hand, a coasting load…).
          if (Math.abs(s.target - s.pos) > 1e-9) {
            const step = s.pushRate * dt;
            s.pos = s.target > s.pos ? Math.min(s.target, s.pos + step) : Math.max(s.target, s.pos - step);
          } else {
            s.wait -= dt;
            if (s.wait <= 0) {
              // Power returns. What each principle knows now:
              //   incremental / SinCos: the counter restarts at 0 right here
              //   resolver / single-turn: the angle is read, the turn count starts at 0
              //   multi-turn: the full position, modulo its range
              const range = mtRangeRef.current;
              s.incOffset = s.pos;
              s.stOffset = Math.floor(s.pos);
              s.mtOffset = Math.floor(s.pos / range) * range;
              s.phase = 'on';
              setPhase('on');
            }
          }
        } else if (runningRef.current && travel > 0) {
          const revPerSec = speedRef.current / 60 / DISPLAY_SLOWDOWN;
          let p = s.pos + s.dir * revPerSec * dt;
          if (p >= travel) {
            p = travel;
            s.dir = -1;
          } else if (p <= 0) {
            p = 0;
            s.dir = 1;
          }
          s.pos = p;
        }
        draw();
        sinceRender += dt;
        if (sinceRender >= 0.1 && s.pos !== renderedPos) {
          sinceRender = 0;
          renderedPos = s.pos;
          setFrame((f) => (f + 1) % 1_000_000);
        }
      }
      last = ts;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  const powerCycle = () => {
    const s = simRef.current;
    if (s.phase !== 'on') return;
    const travel = Math.max(0, travelRef.current);
    // Push 0.6…3.4 rev, in the running direction if there is room, else
    // the other way, else towards whichever end has more room.
    const amount = 0.6 + Math.random() * 2.8;
    const ahead = s.dir > 0 ? travel - s.pos : s.pos;
    const behind = s.dir > 0 ? s.pos : travel - s.pos;
    const sign = ahead >= amount ? s.dir : behind >= amount ? -s.dir : ahead >= behind ? s.dir : -s.dir;
    const target = clamp(s.pos + sign * amount, 0, travel);
    s.target = target;
    s.pushedBy = target - s.pos;
    s.pushRate = Math.max(0.5, Math.abs(target - s.pos) / 1.2);
    s.wait = 0.6;
    s.phase = 'off';
    setPhase('off');
  };

  const home = () => {
    const s = simRef.current;
    s.incOffset = 0;
    s.stOffset = 0;
    s.mtOffset = 0;
    s.pushedBy = null;
    setFrame((f) => (f + 1) % 1_000_000);
  };

  // ---- snapshot for this render ----
  const sim = simRef.current;
  const pos = sim.pos;
  const powered = phase === 'on';

  const incReported = pos - sim.incOffset;
  const stReported = pos - sim.stOffset;
  const mtReported = pos - sim.mtOffset;

  const incState: Verdict = !powered ? 'off' : Math.abs(sim.incOffset) < 1e-9 ? 'ok' : 'lost';
  const stState: Verdict = !powered ? 'off' : Math.abs(sim.stOffset) < 1e-9 ? 'ok' : 'turns';
  const mtState: Verdict = !powered ? 'off' : Math.abs(sim.mtOffset) < 1e-9 ? 'ok' : 'range';

  // ---- per-card numbers ----
  const incCounts = 4 * incLines;
  const incHz = (incLines * speedRpm) / 60;
  const sinCounts = sinCosPeriods * Math.pow(2, sinCosInterpBits);
  const sinHz = (sinCosPeriods * speedRpm) / 60;
  const resCounts = Math.pow(2, RESOLVER.bits);
  const stCounts = Math.pow(2, st.bits);
  const mtCounts = Math.pow(2, mt.bits);
  const mtRangeMm = mtRangeRev * leadMm;
  const axisSpeed = (speedRpm / 60) * leadMm;
  const ssiTooWide = mtIsExt && mtExtIface === 'ssi' && mtExtBits + mtExtTurnBits > (EXT_IFACE.ssi.maxBits ?? 32);

  const incVerdict = signalVerdict(
    incHz,
    incSignal === 'ttl'
      ? [
          { hz: LIMIT.el5101Hz, name: 'EL5101' },
          { hz: LIMIT.el5101_0010Hz, name: 'EL5101-0010' },
        ]
      : [{ hz: LIMIT.el5151Hz, name: 'EL5151' }],
    incLines,
  );
  const sinVerdict = signalVerdict(sinHz, [{ hz: LIMIT.el5021Hz, name: 'EL5021' }], sinCosPeriods);

  const leadText = `${fmtSig(leadMm)} mm`;
  const lastPush = sim.pushedBy;

  return (
    <div className="nc-enc-block">
      <div className="nc-enc-block-header">
        <span className="nc-enc-block-title" title="Encoder compare (feedback)">
          Encoder compare (feedback)
        </span>
        <span className="nc-enc-block-actions">
          <button
            type="button"
            className="nc-enc-block-iconbtn"
            onClick={() => onChange({ running: !block.running })}
            title={block.running ? 'Pause' : 'Play'}
            aria-label={block.running ? 'Pause animation' : 'Play animation'}
          >
            {block.running ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className="nc-enc-block-iconbtn"
            onClick={onDelete}
            title="Delete widget"
            aria-label="Delete widget"
          >
            ✕
          </button>
        </span>
      </div>

      <div className="nc-enc-block-body">
        {/* Operating point */}
        <div className="nc-enc-controls">
          <Slider
            label="Motor speed"
            text={`${fmtInt(speedRpm)} rpm`}
            min={0}
            max={6000}
            step={50}
            value={speedRpm}
            onInput={(v) => onChange({ speedRpm: clamp(v, 0, 6000) })}
          />
          <Slider
            label="Travel per motor rev"
            text={leadText}
            min={0}
            max={LEAD_STEPS.length - 1}
            step={1}
            value={nearestStep(LEAD_STEPS, leadMm)}
            onInput={(i) => onChange({ leadMm: LEAD_STEPS[clamp(Math.round(i), 0, LEAD_STEPS.length - 1)] })}
          />
          <Slider
            label="Axis travel"
            text={fmtLength(travelMm)}
            min={0}
            max={TRAVEL_STEPS.length - 1}
            step={1}
            value={nearestStep(TRAVEL_STEPS, travelMm)}
            onInput={(i) =>
              onChange({ travelMm: TRAVEL_STEPS[clamp(Math.round(i), 0, TRAVEL_STEPS.length - 1)] })
            }
          />
        </div>
        <div className="nc-enc-summary">
          <strong>{fmtInt(speedRpm)} rpm</strong> × <strong>{leadText}/rev</strong> ={' '}
          <strong>{fmtSpeed(axisSpeed)}</strong> axis speed · travel <strong>{fmtLength(travelMm)}</strong> ={' '}
          <strong>{fmtRevCount(travelRev)} motor rev</strong>
        </div>

        {/* Stage: shaft + axis + power cycle */}
        <div className="nc-enc-stage">
          <ShaftDisc discRef={discRef} powered={powered} />
          <div className="nc-enc-stage-side">
            <div className="nc-enc-truth">
              <span className="nc-enc-truth-label">True position</span>
              <span className="nc-enc-truth-val">
                {fmtRev(pos)} rev · {fmtLength(pos * leadMm)}
              </span>
            </div>
            <div className="nc-enc-axis" aria-hidden="true">
              <div className="nc-enc-axis-track">
                <div className="nc-enc-axis-rail" />
                <div className="nc-enc-axis-carriage" ref={carriageRef} />
              </div>
              <div className="nc-enc-axis-scale">
                <span>0</span>
                <span>{fmtLength(travelMm)}</span>
              </div>
            </div>
            <div className="nc-enc-stage-actions">
              <button
                type="button"
                className={`nc-enc-btn nc-enc-btn-power${powered ? '' : ' is-off'}`}
                onClick={powerCycle}
                disabled={!powered}
                title="Drop the power, push the axis a few revolutions, power up again"
              >
                {powered ? '⏻ Power cycle' : '⏻ Power off — axis moving…'}
              </button>
              <button
                type="button"
                className="nc-enc-btn"
                onClick={home}
                disabled={!powered}
                title="Reference all five to the true position"
              >
                ⌂ Home all
              </button>
            </div>
            <div className="nc-enc-event" role="status">
              {!powered
                ? 'No power: nothing is counting while the axis is pushed.'
                : lastPush !== null
                  ? `Power back. The axis moved ${lastPush >= 0 ? '+' : '−'}${Math.abs(lastPush).toFixed(2)} rev while unpowered — compare each card with the true position.`
                  : 'Press Power cycle: the power drops, the axis is pushed a few revolutions, the power returns.'}
            </div>
          </div>
        </div>

        {/* One card per principle */}
        <div className="nc-enc-cards">
          <Card
            k="inc"
            name="Incremental"
            badge="relative"
            badgeTone="rel"
            powered={powered}
            controls={
              <>
                <Select
                  label="Lines/rev"
                  value={String(incLines)}
                  options={INC_LINES.map((n) => ({ value: String(n), label: fmtInt(n) }))}
                  onChange={(v) => onChange({ incLines: Number(v) })}
                />
                <Select
                  label="Signal"
                  value={incSignal}
                  options={[
                    { value: 'ttl', label: '5 V TTL / RS422' },
                    { value: 'htl', label: '24 V HTL' },
                  ]}
                  onChange={(v) => onChange({ incSignal: v })}
                />
              </>
            }
            raw={`${fmtInt(incReported * incCounts)} counts`}
            reported={incReported}
            truth={pos}
            leadMm={leadMm}
            verdict={incState}
            verdictText={{ ok: '✓ referenced', lost: '✗ lost — home it' }}
            metrics={[
              {
                name: 'Counts/rev',
                value: fmtInt(incCounts),
                worked: `4 × ${fmtInt(incLines)} lines (4-fold A/B edges)`,
              },
              {
                name: 'Resolution',
                value: `${fmtArcsec(ARCSEC_PER_REV / incCounts)} · ${fmtLinear((leadMm * 1000) / incCounts)}`,
              },
              {
                name: 'Signal',
                value: fmtHz(incHz),
                worked: `${fmtInt(incLines)} × ${fmtInt(speedRpm)} / 60`,
                verdict: incVerdict,
              },
            ]}
            hardware={
              incSignal === 'ttl'
                ? 'EL5101 (1 MHz) · EL5101-0010 (5 MHz, RS422) · AX8000 multi-feedback -0x20'
                : 'EL5151 (100 kHz)'
            }
            note="Counts from wherever it was switched on. The index pulse C (once per rev) plus a reference switch give home."
          />

          <Card
            k="sincos"
            name="SinCos 1 Vpp"
            badge="relative"
            badgeTone="rel"
            powered={powered}
            controls={
              <>
                <Select
                  label="Periods/rev"
                  value={String(sinCosPeriods)}
                  options={SINCOS_PERIODS.map((n) => ({ value: String(n), label: fmtInt(n) }))}
                  onChange={(v) => onChange({ sinCosPeriods: Number(v) })}
                />
                <Select
                  label="Interpolation"
                  value={String(sinCosInterpBits)}
                  options={[8, 9, 10, 11, 12, 13].map((b) => ({ value: String(b), label: `${b} bit` }))}
                  onChange={(v) => onChange({ sinCosInterpBits: Number(v) })}
                />
              </>
            }
            raw={`${fmtInt(incReported * sinCounts)} counts`}
            reported={incReported}
            truth={pos}
            leadMm={leadMm}
            verdict={incState}
            verdictText={{ ok: '✓ referenced', lost: '✗ lost — home it' }}
            metrics={[
              {
                name: 'Counts/rev',
                value: fmtInt(sinCounts),
                worked: `${fmtInt(sinCosPeriods)} periods × 2^${sinCosInterpBits}`,
              },
              {
                name: 'Resolution',
                value: `${fmtArcsec(ARCSEC_PER_REV / sinCounts)} · ${fmtLinear((leadMm * 1000) / sinCounts)}`,
              },
              {
                name: 'Signal',
                value: fmtHz(sinHz),
                worked: `${fmtInt(sinCosPeriods)} × ${fmtInt(speedRpm)} / 60`,
                verdict: sinVerdict,
              },
            ]}
            hardware="EL5021 (250 kHz, ≤ 13 bit/period) · AX5000 · AX8000 multi-feedback -0x20"
            note="Analog sine/cosine, interpolated inside each period. Still relative — unless the encoder adds a digital absolute channel (EnDat, BiSS, Hiperface)."
          />

          <Card
            k="resolver"
            name="Resolver"
            badge="absolute · 1 rev"
            badgeTone="st"
            powered={powered}
            controls={<div className="nc-enc-fixed">AM8000 y = 0 · separate feedback cable</div>}
            raw={`${fmtInt(Math.floor(frac(pos) * resCounts))} / ${fmtInt(resCounts)}`}
            reported={stReported}
            truth={pos}
            leadMm={leadMm}
            verdict={stState}
            verdictText={{ ok: '✓ referenced', turns: '~ angle ✓ · turns lost' }}
            metrics={[
              { name: 'Counts/rev', value: fmtInt(resCounts), worked: `2^${RESOLVER.bits} (drive evaluation)` },
              {
                name: 'Resolution',
                value: `${fmtArcsec(ARCSEC_PER_REV / resCounts)} · ${fmtLinear((leadMm * 1000) / resCounts)}`,
              },
              { name: 'Accuracy', value: `±${RESOLVER.accuracyArcsec}″ (≈ 0.17°)` },
              singleTurnTravelMetric(travelRev),
            ]}
            hardware="AX5000 · EL7201 / EL7211 (AM81xx, 48 V) — AX8000 has no resolver input"
            note="Analog transformer, no electronics in the motor — rugged. A 2-pole resolver is absolute within one revolution only."
          />

          <Card
            k="st"
            name="Absolute single-turn"
            badge="absolute · 1 rev"
            badgeTone="st"
            powered={powered}
            controls={
              <AbsControls
                variants={ST_VARIANTS}
                value={stIsExt ? 'ext' : st.code}
                onVariant={(code) => onChange({ stVariant: code })}
                ext={stIsExt}
                iface={stExtIface}
                bits={stExtBits}
                onIface={(v) => onChange({ stExtInterface: v })}
                onBits={(b) => onChange({ stExtBits: b })}
              />
            }
            raw={`${fmtInt(Math.floor(frac(pos) * stCounts))} / ${fmtInt(stCounts)}`}
            reported={stReported}
            truth={pos}
            leadMm={leadMm}
            verdict={stState}
            verdictText={{ ok: '✓ referenced', turns: '~ angle ✓ · turns lost' }}
            metrics={[
              { name: 'Counts/rev', value: fmtInt(stCounts), worked: `2^${st.bits}` },
              {
                name: 'Resolution',
                value: `${fmtArcsec(ARCSEC_PER_REV / stCounts)} · ${fmtLinear((leadMm * 1000) / stCounts)}`,
              },
              {
                name: 'Accuracy',
                value: st.accuracyArcsec !== null ? `±${st.accuracyArcsec}″` : 'see encoder datasheet',
              },
              singleTurnTravelMetric(travelRev),
            ]}
            hardware={st.hardware}
            safety={st.safety}
            note={[st.signal, st.note].filter(Boolean).join('. ')}
          />

          <Card
            k="mt"
            name="Absolute multi-turn"
            badge={`absolute · ${fmtInt(mtRangeRev)} rev`}
            badgeTone="mt"
            powered={powered}
            controls={
              <AbsControls
                variants={MT_VARIANTS}
                value={mtIsExt ? 'ext' : mt.code}
                onVariant={(code) => onChange({ mtVariant: code })}
                ext={mtIsExt}
                iface={mtExtIface}
                bits={mtExtBits}
                turnBits={mtExtTurnBits}
                onIface={(v) => onChange({ mtExtInterface: v })}
                onBits={(b) => onChange({ mtExtBits: b })}
                onTurnBits={(b) => onChange({ mtExtTurnBits: b })}
              />
            }
            raw={`turn ${fmtInt(Math.floor(pos) % mtRangeRev)} · ${fmtInt(Math.floor(frac(pos) * mtCounts))}`}
            reported={mtReported}
            truth={pos}
            leadMm={leadMm}
            verdict={mtState}
            verdictText={{ ok: '✓ knows position', range: `✗ wrapped — beyond ${fmtInt(mtRangeRev)} rev` }}
            metrics={[
              { name: 'Counts/rev', value: fmtInt(mtCounts), worked: `2^${mt.bits}` },
              {
                name: 'Resolution',
                value: `${fmtArcsec(ARCSEC_PER_REV / mtCounts)} · ${fmtLinear((leadMm * 1000) / mtCounts)}`,
              },
              {
                name: 'Accuracy',
                value: mt.accuracyArcsec !== null ? `±${mt.accuracyArcsec}″` : 'see encoder datasheet',
              },
              {
                name: 'Range',
                value: `${fmtInt(mtRangeRev)} rev = ${fmtLength(mtRangeMm)}`,
                worked: `2^${mt.turnBits} turns × ${leadText}`,
                verdict:
                  travelRev > mtRangeRev
                    ? { ok: false, text: `travel ${fmtLength(travelMm)} exceeds it` }
                    : { ok: true, text: `covers the ${fmtLength(travelMm)} travel` },
              },
            ]}
            hardware={mt.hardware}
            safety={mt.safety}
            warn={
              ssiTooWide
                ? `SSI on the EL5001 reads at most 32 bit; ${mtExtBits} + ${mtExtTurnBits} = ${mtExtBits + mtExtTurnBits}.`
                : undefined
            }
            note={[mt.signal, mt.note].filter(Boolean).join('. ')}
          />
        </div>

        <Matrix />

        <div className="nc-enc-foot">
          <div className="nc-enc-foot-note">
            <strong>Resolution is not accuracy:</strong> 24 bit resolves 0.077″ per count, but the OCT 24-bit
            encoder is specified to ±25″. Counts are raw encoder steps; the drive / NC scales them to mm. The
            animation runs {DISPLAY_SLOWDOWN}× slower than the set speed; every number uses the real speed.
          </div>
          <div className="nc-enc-foot-note">
            Sources (Beckhoff): AM8000 feedback codes, resolution and accuracy from the AM8000 / AM8100 manuals
            (Infosys), the AX8000 manual and the AM8000 product pages; terminal limits from the EL5101 (1 MHz),
            EL5101-0010 (5 MHz), EL5151 (100 kHz), EL5021 (250 kHz, ≤ 13 bit per period — the usable
            interpolation drops at high input frequency), EL5001, EL5032, EL5042 and EL72xx product pages;
            AX8000 multi-feedback (-0x10: EnDat 2.2 / BiSS C, -0x20: also TTL and SinCos 1 Vpp); SKM36 from SICK.
            EnDat 3 (I / J): type key, AX8000 manual and product pages say 19 bit; one Beckhoff page says 24 bit.
            † Code B: range not stated in the sources checked — 4096 rev assumed like the other OCT multi-turn
            codes. Code N (sensorless, no feedback) is not shown.
          </div>
        </div>
      </div>
    </div>
  );
}

/** Signal frequency against a list of terminal limits (first that fits wins). */
function signalVerdict(
  hz: number,
  limits: { hz: number; name: string }[],
  perRev: number,
): { ok: boolean; text: string } {
  const first = limits[0];
  const maxRpm = (lim: number) => fmtInt((lim * 60) / perRev);
  if (hz <= first.hz) return { ok: true, text: `≤ ${fmtHz(first.hz)} ${first.name} · max ${maxRpm(first.hz)} rpm` };
  const alt = limits.slice(1).find((l) => hz <= l.hz);
  if (alt) return { ok: false, text: `> ${fmtHz(first.hz)} ${first.name} — use ${alt.name} (${fmtHz(alt.hz)})` };
  const top = limits[limits.length - 1];
  return { ok: false, text: `> ${fmtHz(top.hz)} ${top.name} · max ${maxRpm(top.hz)} rpm` };
}

function singleTurnTravelMetric(travelRev: number): Metric {
  return travelRev <= 1
    ? {
        name: 'Travel',
        value: `${fmtSig(travelRev)} rev`,
        verdict: { ok: true, text: 'within one turn — absolute' },
      }
    : {
        name: 'Travel',
        value: `${fmtRevCount(travelRev)} rev`,
        verdict: { ok: false, text: 'turn count lost at power-up' },
      };
}

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

type Verdict = 'ok' | 'off' | 'lost' | 'turns' | 'range';

interface Metric {
  name: string;
  value: string;
  worked?: string;
  verdict?: { ok: boolean; text: string };
}

function Card({
  k,
  name,
  badge,
  badgeTone,
  powered,
  controls,
  raw,
  reported,
  truth,
  leadMm,
  verdict,
  verdictText,
  metrics,
  hardware,
  safety,
  warn,
  note,
}: {
  k: CardKey;
  name: string;
  badge: string;
  badgeTone: 'rel' | 'st' | 'mt';
  powered: boolean;
  controls: React.ReactNode;
  raw: string;
  reported: number;
  truth: number;
  leadMm: number;
  verdict: Verdict;
  verdictText: Partial<Record<Verdict, string>>;
  metrics: Metric[];
  hardware: string;
  safety?: string;
  warn?: string;
  note?: string;
}) {
  const err = reported - truth;
  const tone = verdict === 'ok' ? 'ok' : verdict === 'turns' ? 'warn' : verdict === 'off' ? 'off' : 'bad';
  return (
    <div className={`nc-enc-card${powered ? '' : ' is-unpowered'}`} data-card={k}>
      <div className="nc-enc-card-head">
        <span className="nc-enc-card-name">
          <span className="nc-enc-swatch" style={{ background: COLOR[k] }} />
          {name}
        </span>
        <span className={`nc-enc-badge nc-enc-badge-${badgeTone}`}>{badge}</span>
      </div>

      <div className="nc-enc-card-controls">{controls}</div>

      <div className="nc-enc-live">
        <div className="nc-enc-live-row">
          <span className="nc-enc-live-name">Reads</span>
          <span className="nc-enc-live-val">{powered ? raw : '—'}</span>
        </div>
        <div className="nc-enc-live-row">
          <span className="nc-enc-live-name">Position</span>
          <span className="nc-enc-live-val">
            {powered ? `${fmtRev(reported)} rev · ${fmtSignedLength(reported * leadMm)}` : 'no power'}
          </span>
        </div>
        <div className="nc-enc-live-row">
          <span className={`nc-enc-verdict ${tone}`}>
            {verdict === 'off' ? '— no power' : (verdictText[verdict] ?? '')}
          </span>
          {powered && Math.abs(err) > 0.0005 && <span className="nc-enc-err">off by {fmtRev(err)} rev</span>}
        </div>
      </div>

      <div className="nc-enc-metrics">
        {metrics.map((m) => (
          <div key={m.name} className="nc-enc-metric">
            <div className="nc-enc-metric-top">
              <span className="nc-enc-metric-name">{m.name}</span>
              <span className="nc-enc-metric-val">{m.value}</span>
            </div>
            {m.worked && <div className="nc-enc-worked">{m.worked}</div>}
            {m.verdict && (
              <span className={`nc-enc-chip ${m.verdict.ok ? 'ok' : 'bad'}`}>
                {m.verdict.ok ? '✓' : '✗'} {m.verdict.text}
              </span>
            )}
          </div>
        ))}
      </div>

      {warn && <div className="nc-enc-warn">⚠ {warn}</div>}

      <div className="nc-enc-hw">
        <span className="nc-enc-hw-label">Beckhoff</span>
        <span className="nc-enc-hw-text">{hardware}</span>
        {safety && <span className="nc-enc-safety">{safety}</span>}
      </div>
      {note && <div className="nc-enc-note">{note}</div>}
    </div>
  );
}

function AbsControls({
  variants,
  value,
  onVariant,
  ext,
  iface,
  bits,
  turnBits,
  onIface,
  onBits,
  onTurnBits,
}: {
  variants: AbsVariant[];
  value: string;
  onVariant: (code: string) => void;
  ext: boolean;
  iface: ExtInterface;
  bits: number;
  turnBits?: number;
  onIface: (v: ExtInterface) => void;
  onBits: (b: number) => void;
  onTurnBits?: (b: number) => void;
}) {
  return (
    <>
      <Select
        label="AM8000 feedback (y)"
        value={value}
        options={[
          ...variants.map((v) => ({ value: v.code, label: v.label })),
          { value: 'ext', label: 'Third-party encoder' },
        ]}
        onChange={onVariant}
        wide
      />
      {ext && (
        <>
          <Select
            label="Interface"
            value={iface}
            options={[
              { value: 'ssi', label: 'SSI' },
              { value: 'biss', label: 'BiSS C' },
              { value: 'endat', label: 'EnDat 2.2' },
            ]}
            onChange={(v) => onIface(asIface(v))}
          />
          <Select
            label="Bits/rev"
            value={String(bits)}
            options={EXT_BITS.map((b) => ({ value: String(b), label: `${b} bit` }))}
            onChange={(v) => onBits(Number(v))}
          />
          {turnBits !== undefined && onTurnBits && (
            <Select
              label="Turns"
              value={String(turnBits)}
              options={EXT_TURN_BITS.map((b) => ({ value: String(b), label: `${b} bit (${fmtInt(Math.pow(2, b))})` }))}
              onChange={(v) => onTurnBits(Number(v))}
            />
          )}
        </>
      )}
    </>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  wide,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  wide?: boolean;
}) {
  return (
    <label className={`nc-enc-select${wide ? ' is-wide' : ''}`}>
      <span className="nc-enc-select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Slider({
  label,
  text,
  value,
  min,
  max,
  step,
  onInput,
}: {
  label: string;
  text: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onInput: (v: number) => void;
}) {
  return (
    <label className="nc-enc-control">
      <span className="nc-enc-control-label">
        {label}
        <strong>{text}</strong>
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

/**
 * The shaft as a code disc: an outer ring of fine ticks (the
 * incremental track), four Gray-code rings (an absolute code: finest
 * outside, coarsest inside), and the red index mark. The read head is
 * fixed at 12 o'clock; only the inner group rotates (via discRef).
 */
const ShaftDisc = memo(function ShaftDisc({
  discRef,
  powered,
}: {
  discRef: React.MutableRefObject<SVGGElement | null>;
  powered: boolean;
}) {
  const R = 88;
  const ticks = 64;
  const rings = [
    { r: 70, bit: 1 },
    { r: 60, bit: 2 },
    { r: 50, bit: 4 },
    { r: 40, bit: 8 },
  ];
  const sectors = 16;
  const arc = (r: number, a0: number, a1: number) => {
    const p = (a: number) => [Math.sin(a) * r, -Math.cos(a) * r];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  return (
    <svg
      className={`nc-enc-disc${powered ? '' : ' is-unpowered'}`}
      viewBox="-110 -110 220 220"
      role="img"
      aria-label="Encoder code disc on the motor shaft"
    >
      <circle r={R + 6} className="nc-enc-disc-rim" />
      <g ref={discRef}>
        <circle r={R} className="nc-enc-disc-face" />
        {Array.from({ length: ticks }).map((_, i) => {
          const a = (i / ticks) * Math.PI * 2;
          return (
            <line
              key={i}
              x1={Math.sin(a) * (R - 8)}
              y1={-Math.cos(a) * (R - 8)}
              x2={Math.sin(a) * (R - 1)}
              y2={-Math.cos(a) * (R - 1)}
              className="nc-enc-disc-tick"
            />
          );
        })}
        {rings.map((ring) =>
          Array.from({ length: sectors }).map((_, i) => {
            // Gray code per sector: neighbouring sectors differ in one ring only.
            const gray = i ^ (i >> 1);
            if (!(gray & ring.bit)) return null;
            const a0 = (i / sectors) * Math.PI * 2;
            const a1 = ((i + 1) / sectors) * Math.PI * 2;
            return <path key={`${ring.r}-${i}`} d={arc(ring.r, a0, a1)} className="nc-enc-disc-code" />;
          }),
        )}
        <line x1={0} y1={-(R - 1)} x2={0} y2={-(R - 10)} className="nc-enc-disc-index" />
        <circle r={12} className="nc-enc-disc-hub" />
      </g>
      <path d={`M -7 ${-R - 17} L 7 ${-R - 17} L 0 ${-R - 5} Z`} className="nc-enc-disc-head" />
    </svg>
  );
});

const MATRIX_ROWS: { k: CardKey; name: string; cells: string[] }[] = [
  {
    k: 'inc',
    name: 'Incremental',
    cells: [
      '✗ lost',
      'every power-up',
      'unlimited (counter)',
      '4 × lines',
      'square wave, 5 V TTL/RS422 or 24 V HTL',
      'EL5101(-0010), EL5151, AX8000 MFI',
      'TwinSAFE SC: EL5101-0090, EL5151-0090',
    ],
  },
  {
    k: 'sincos',
    name: 'SinCos 1 Vpp',
    cells: [
      '✗ lost',
      'every power-up',
      'unlimited (counter)',
      'periods × 2^8…13',
      'analog sine/cosine',
      'EL5021, AX5000, AX8000 MFI',
      'TwinSAFE SC: EL5021-0090',
    ],
  },
  {
    k: 'resolver',
    name: 'Resolver',
    cells: [
      '~ angle only',
      'unless travel ≤ 1 rev',
      '1 rev',
      '14 bit, ±600″',
      'analog, separate cable',
      'AM8000 y=0; AX5000, EL7201/EL7211',
      '—',
    ],
  },
  {
    k: 'st',
    name: 'Absolute single-turn',
    cells: [
      '~ angle only',
      'unless travel ≤ 1 rev',
      '1 rev',
      '18 / 19 / 23 / 24 bit',
      'digital — OCT in the motor cable',
      'AM8000 y=1, A, G, I, 3; EL5001/EL5032/EL5042',
      'SIL 2 (G) · SIL 3 (I)',
    ],
  },
  {
    k: 'mt',
    name: 'Absolute multi-turn',
    cells: [
      '✓ full position',
      'once, at commissioning',
      '4096 rev (12-bit turns)',
      '18 / 19 / 23 / 24 bit',
      'digital — OCT in the motor cable',
      'AM8000 y=2, B, H, L, J, 4; EL5001/EL5032/EL5042',
      'SIL 2 (H, L) · SIL 3 (J)',
    ],
  },
];

const Matrix = memo(function Matrix() {
  return (
    <div className="nc-enc-matrix-wrap">
      <table className="nc-enc-matrix">
        <thead>
          <tr>
            <th scope="col">Principle</th>
            <th scope="col">After power-up</th>
            <th scope="col">Homing</th>
            <th scope="col">Range</th>
            <th scope="col">Resolution</th>
            <th scope="col">Signal / cable</th>
            <th scope="col">Beckhoff</th>
            <th scope="col">Safety</th>
          </tr>
        </thead>
        <tbody>
          {MATRIX_ROWS.map((r) => (
            <tr key={r.k}>
              <th scope="row">
                <span className="nc-enc-swatch" style={{ background: COLOR[r.k] }} /> {r.name}
              </th>
              {r.cells.map((c, i) => (
                <td key={i}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="nc-enc-matrix-note">
        MFI = AX8000 multi-feedback interface. OCT = One Cable Technology: the feedback rides in the motor
        cable; resolver and Hiperface need a second cable.
      </div>
    </div>
  );
});
