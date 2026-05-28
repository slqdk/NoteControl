import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { MotorBlockDto } from '../api/types';

/**
 * Synchronous vs. asynchronous motor comparison widget.
 *
 * A rotating stator field (blue) drives two rotors side by side:
 *   - Synchronous (orange magnetized rotor): locked to the field, no
 *     slip — the rotor arrow always points exactly where the field
 *     points.
 *   - Asynchronous (green squirrel-cage rotor): lags the field by the
 *     slip s, which grows linearly with mechanical load. Under no load
 *     it nearly keeps up; under full load it falls visibly behind.
 *
 * Both machines share pole-pairs and line frequency, so the field and
 * the synchronous speed are identical for the two — the ONLY difference
 * the user sees is the async rotor trailing the field. That's the whole
 * teaching point.
 *
 * Physics (simplified for intuition, not metrology):
 *   synchronous speed  n_s = 60 · f / p          [rpm]   (p = pole pairs)
 *   slip               s   = (load/100)·(ratedSlipPct/100), clamped ≥ 0
 *   async rotor speed  n_r = n_s · (1 − s)        [rpm]
 *
 * Animation: a single requestAnimationFrame loop advances the field
 * angle by the synchronous angular velocity, and the two rotor angles
 * by their respective speeds. The visual spin is SLOWED by a fixed
 * display factor so 1000+ rpm doesn't blur — the readouts show the real
 * numbers. Pausing freezes all angles.
 *
 * Hosted by NoteWidgetStack exactly like the other note widgets:
 * { block, onChange(patch), onDelete }, drag/x/y inert, host owns width
 * + the resize handle.
 */

export interface MotorBlockProps {
  block: MotorBlockDto;
  onChange: (patch: Partial<MotorBlockDto>) => void;
  onDelete: () => void;
}

// Visual spin slowdown: real rpm can be 3000; spinning that fast on
// screen is a useless blur. We divide the on-screen angular velocity by
// this factor. The numeric readouts are unaffected — they show truth.
const DISPLAY_SLOWDOWN = 30;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Synchronous speed in rpm: n_s = 60·f / p. Guards p ≥ 1. */
function syncRpm(frequencyHz: number, polePairs: number): number {
  const p = Math.max(1, polePairs);
  return (60 * frequencyHz) / p;
}

/** Slip as a fraction 0..1 from load + rated slip. */
function slipFraction(loadPct: number, ratedSlipPct: number): number {
  const s = (clamp(loadPct, 0, 100) / 100) * (Math.max(0, ratedSlipPct) / 100);
  // Cap below 1 so the rotor never stalls/reverses in the model.
  return clamp(s, 0, 0.95);
}

export function MotorBlock({ block, onChange, onDelete }: MotorBlockProps) {
  // Live rotation angles (radians). Kept in refs so the rAF loop can
  // mutate them every frame without forcing React re-renders; we mirror
  // them into state only at the cadence needed to redraw (we redraw via
  // direct DOM transforms on the SVG groups, so state isn't needed for
  // the spin itself).
  const fieldAngleRef = useRef(0);
  const syncAngleRef = useRef(0);
  const asyncAngleRef = useRef(0);

  // SVG group refs we rotate directly each frame (cheap; no React).
  const fieldSyncRef = useRef<SVGGElement | null>(null);
  const rotorSyncRef = useRef<SVGGElement | null>(null);
  const fieldAsyncRef = useRef<SVGGElement | null>(null);
  const rotorAsyncRef = useRef<SVGGElement | null>(null);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // Derived physics. Memoised so the rAF effect only restarts when an
  // input that changes the speeds changes.
  const nSync = useMemo(
    () => syncRpm(block.frequencyHz, block.polePairs),
    [block.frequencyHz, block.polePairs],
  );
  const slip = useMemo(
    () => slipFraction(block.loadPct, block.ratedSlipPct),
    [block.loadPct, block.ratedSlipPct],
  );
  const nAsync = useMemo(() => nSync * (1 - slip), [nSync, slip]);

  // rpm → rad/s for the on-screen spin (with slowdown). 1 rpm =
  // 2π/60 rad/s.
  const wField = (nSync * Math.PI) / 30 / DISPLAY_SLOWDOWN;
  const wAsync = (nAsync * Math.PI) / 30 / DISPLAY_SLOWDOWN;

  // Keep the latest angular velocities in refs so the loop reads fresh
  // values without re-subscribing every input tick.
  const wFieldRef = useRef(wField);
  const wAsyncRef = useRef(wAsync);
  wFieldRef.current = wField;
  wAsyncRef.current = wAsync;

  const applyTransforms = useCallback(() => {
    const deg = (rad: number) => (rad * 180) / Math.PI;
    // Field groups rotate at the synchronous rate (same for both).
    const fAngle = deg(fieldAngleRef.current);
    if (fieldSyncRef.current)
      fieldSyncRef.current.setAttribute('transform', `rotate(${fAngle} 0 0)`);
    if (fieldAsyncRef.current)
      fieldAsyncRef.current.setAttribute('transform', `rotate(${fAngle} 0 0)`);
    // Sync rotor tracks the field exactly.
    if (rotorSyncRef.current)
      rotorSyncRef.current.setAttribute(
        'transform',
        `rotate(${deg(syncAngleRef.current)} 0 0)`,
      );
    // Async rotor lags.
    if (rotorAsyncRef.current)
      rotorAsyncRef.current.setAttribute(
        'transform',
        `rotate(${deg(asyncAngleRef.current)} 0 0)`,
      );
  }, []);

  // The animation loop. Runs only while block.running. Advances angles
  // by ω·dt each frame. Sync rotor shares the field's angle (zero slip);
  // async advances at its own (slower) rate so the gap to the field
  // opens continuously — which is exactly how slip looks.
  useEffect(() => {
    if (!block.running) {
      // Make sure the last positions are drawn, then idle.
      applyTransforms();
      return;
    }
    const tick = (ts: number) => {
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      if (last != null) {
        const dt = (ts - last) / 1000; // seconds
        fieldAngleRef.current += wFieldRef.current * dt;
        // Sync rotor == field (locked).
        syncAngleRef.current = fieldAngleRef.current;
        // Async rotor advances slower; the field pulls ahead.
        asyncAngleRef.current += wAsyncRef.current * dt;
        applyTransforms();
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, [block.running, applyTransforms]);

  // Draw once on mount / when paused so the initial frame isn't blank.
  useEffect(() => {
    applyTransforms();
  }, [applyTransforms]);

  // ---- input handlers ---------------------------------------------------
  // The Hz and rpm sliders are two views of the same field speed, linked
  // by the shared pole-pairs: rpm = 60·f/p  ⇔  f = rpm·p/60. Moving one
  // writes frequencyHz (the single source of truth); the rpm slider is
  // derived for display and converts back on change.
  const onHz = useCallback(
    (hz: number) => onChange({ frequencyHz: clamp(hz, 0, 100) }),
    [onChange],
  );
  const onRpm = useCallback(
    (rpm: number) => {
      // rpm → Hz via shared pole pairs. Clamp Hz to its slider range.
      const hz = clamp((rpm * Math.max(1, block.polePairs)) / 60, 0, 100);
      onChange({ frequencyHz: hz });
    },
    [onChange, block.polePairs],
  );
  const onPolePairs = useCallback(
    (p: number) => onChange({ polePairs: clamp(Math.round(p), 1, 12) }),
    [onChange],
  );
  const onLoad = useCallback(
    (v: number) => onChange({ loadPct: clamp(v, 0, 100) }),
    [onChange],
  );
  const onRatedSlip = useCallback(
    (v: number) => onChange({ ratedSlipPct: clamp(v, 0, 20) }),
    [onChange],
  );

  // rpm shown on the field-speed rpm slider (max at 100 Hz for current p).
  const rpmValue = Math.round(nSync);
  const rpmMax = Math.round(syncRpm(100, block.polePairs));

  const slipPctText = (slip * 100).toFixed(1);

  return (
    <div className="nc-motor-block">
      <div className="nc-motor-block-header">
        <span className="nc-motor-block-title" title="Synchronous vs. asynchronous motor">
          Synchronous vs. asynchronous motor
        </span>
        <span className="nc-motor-block-actions">
          <button
            type="button"
            className="nc-motor-block-iconbtn"
            onClick={() => onChange({ running: !block.running })}
            title={block.running ? 'Pause' : 'Play'}
            aria-label={block.running ? 'Pause animation' : 'Play animation'}
          >
            {block.running ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className="nc-motor-block-iconbtn"
            onClick={onDelete}
            title="Delete widget"
            aria-label="Delete widget"
          >
            ✕
          </button>
        </span>
      </div>

      <div className="nc-motor-block-body">
        {/* Controls */}
        <div className="nc-motor-controls">
          <label className="nc-motor-control">
            <span className="nc-motor-control-label">
              Pole pairs (p)
              <strong>{block.polePairs}</strong>
            </span>
            <input
              type="range"
              min={1}
              max={12}
              step={1}
              value={block.polePairs}
              onChange={(e) => onPolePairs(Number(e.target.value))}
            />
          </label>

          <label className="nc-motor-control">
            <span className="nc-motor-control-label">
              Frequency
              <strong>{block.frequencyHz.toFixed(0)} Hz</strong>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(block.frequencyHz)}
              onChange={(e) => onHz(Number(e.target.value))}
            />
          </label>

          <label className="nc-motor-control">
            <span className="nc-motor-control-label">
              Field speed
              <strong>{rpmValue} rpm</strong>
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(1, rpmMax)}
              step={1}
              value={clamp(rpmValue, 0, Math.max(1, rpmMax))}
              onChange={(e) => onRpm(Number(e.target.value))}
            />
          </label>

          <label className="nc-motor-control">
            <span className="nc-motor-control-label">
              Load
              <strong>{block.loadPct.toFixed(0)}%</strong>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(block.loadPct)}
              onChange={(e) => onLoad(Number(e.target.value))}
            />
          </label>

          <label className="nc-motor-control">
            <span className="nc-motor-control-label">
              Rated slip
              <strong>{block.ratedSlipPct.toFixed(1)}%</strong>
            </span>
            <input
              type="range"
              min={0}
              max={20}
              step={0.5}
              value={block.ratedSlipPct}
              onChange={(e) => onRatedSlip(Number(e.target.value))}
            />
          </label>
        </div>

        {/* The two machines */}
        <div className="nc-motor-stage">
          <MotorPanel
            kind="sync"
            label="Synchronous motor"
            badge="no slip"
            rpm={Math.round(nSync)}
            fieldRef={fieldSyncRef}
            rotorRef={rotorSyncRef}
          />
          <MotorPanel
            kind="async"
            label="Asynchronous motor"
            badge={`slip ${slipPctText}%`}
            rpm={Math.round(nAsync)}
            fieldRef={fieldAsyncRef}
            rotorRef={rotorAsyncRef}
          />
        </div>

        {/* Legend */}
        <div className="nc-motor-legend">
          <span className="nc-motor-legend-item">
            <span className="nc-motor-swatch nc-motor-swatch-field" /> Stator field
          </span>
          <span className="nc-motor-legend-item">
            <span className="nc-motor-swatch nc-motor-swatch-sync" /> Magnetized rotor
          </span>
          <span className="nc-motor-legend-item">
            <span className="nc-motor-swatch nc-motor-swatch-async" /> Squirrel-cage rotor
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One machine panel: a circular stator with a rotating field line, and
 * a rotor whose drawing depends on kind. The field and rotor groups are
 * rotated by the parent via refs each frame.
 *
 * Geometry: the SVG uses a centred coordinate system (viewBox centred
 * on 0,0) so rotate(angle 0 0) spins about the middle without offset
 * math. A fixed radius keeps both panels identical.
 */
function MotorPanel({
  kind,
  label,
  badge,
  rpm,
  fieldRef,
  rotorRef,
}: {
  kind: 'sync' | 'async';
  label: string;
  badge: string;
  rpm: number;
  fieldRef: React.RefObject<SVGGElement | null>;
  rotorRef: React.RefObject<SVGGElement | null>;
}) {
  const R = 90; // stator radius
  const VB = 220; // viewBox size (centred)
  const half = VB / 2;

  return (
    <div className={`nc-motor-panel nc-motor-panel-${kind}`}>
      <div className="nc-motor-panel-head">
        <span className="nc-motor-panel-label">{label}</span>
        <span className="nc-motor-panel-badge">{badge}</span>
      </div>
      <svg
        className="nc-motor-svg"
        viewBox={`${-half} ${-half} ${VB} ${VB}`}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={`${label}, ${rpm} rpm`}
      >
        {/* Stator outline */}
        <circle
          cx={0}
          cy={0}
          r={R}
          className="nc-motor-stator"
          fill="none"
        />

        {/* Rotating stator field: a diameter line through the centre,
            shown as a coloured bar that sweeps round. */}
        <g ref={fieldRef as React.RefObject<SVGGElement>}>
          <line
            x1={0}
            y1={0}
            x2={R}
            y2={0}
            className="nc-motor-field-line"
          />
          <circle cx={R} cy={0} r={6} className="nc-motor-field-dot" />
        </g>

        {/* Rotor */}
        {kind === 'sync' ? (
          // Synchronous: a magnetized bar magnet (N/S) on the shaft.
          <g ref={rotorRef as React.RefObject<SVGGElement>}>
            <rect
              x={-46}
              y={-14}
              width={92}
              height={28}
              rx={6}
              className="nc-motor-magnet"
            />
            <text x={-30} y={5} className="nc-motor-pole-text">N</text>
            <text x={26} y={5} className="nc-motor-pole-text">S</text>
            <circle cx={0} cy={0} r={5} className="nc-motor-shaft" />
          </g>
        ) : (
          // Asynchronous: a squirrel-cage ring with conductor bars and a
          // marker bar so the lag against the field is visible.
          <g ref={rotorRef as React.RefObject<SVGGElement>}>
            <circle cx={0} cy={0} r={52} className="nc-motor-cage-ring" fill="none" />
            {Array.from({ length: 8 }).map((_, i) => {
              const a = (i / 8) * Math.PI * 2;
              const r1 = 44;
              const r2 = 52;
              return (
                <circle
                  key={i}
                  cx={Math.cos(a) * ((r1 + r2) / 2)}
                  cy={Math.sin(a) * ((r1 + r2) / 2)}
                  r={5}
                  className="nc-motor-cage-bar"
                />
              );
            })}
            {/* Marker conductor (filled) so the rotor's own rotation —
                lagging the field — is unmistakable. */}
            <line
              x1={0}
              y1={0}
              x2={52}
              y2={0}
              className="nc-motor-cage-marker"
            />
            <circle cx={0} cy={0} r={5} className="nc-motor-shaft" />
          </g>
        )}
      </svg>
      <div className="nc-motor-panel-foot">
        <span className="nc-motor-panel-foot-label">Rotor</span>
        <span className="nc-motor-panel-foot-rpm">{rpm} rpm</span>
      </div>
    </div>
  );
}
