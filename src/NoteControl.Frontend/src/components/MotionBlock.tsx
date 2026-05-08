import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MotionBlockDto } from '../api/types';
import {
  calculateForward,
  calculateReverse,
  calculateThirdMode,
  fmt,
  minDistanceForVMax,
  parseNum,
  type MotionResult,
} from '../util/motionMath';
import { drawChart } from '../util/motionChart';

/**
 * One free-floating Motion calculator block on the dashboard.
 *
 * The same component handles all three modes (A, B, C) of the
 * standalone PowerCMD BA Motion Profile calculator. The mode is
 * carried by the DTO so a user picks the mode at insert-time
 * (Widgets+ → Motion → Calculator A/B/C) and the choice is sticky
 * for the lifetime of that block.
 *
 * Why one component instead of three:
 *   - The wrapper is identical: header + drag, body with form +
 *     chart + results, bottom-right resize handle. A three-way
 *     split would triplicate the drag/resize/persistence plumbing.
 *   - The differences are localised: the form fields, the calc
 *     function, and the result labels. All three are small enough
 *     that switching by `mode` keeps the file readable.
 *
 * Inputs are persisted into the block's `inputs` map (a free-form
 * Record<string, number>) on every keystroke. Persistence flows up
 * via onChange, then through useDebouncedSave at the page level —
 * same plumbing as RssBlock's title/feedUrl/etc.
 *
 * Calculations are synchronous and cheap (analytic + ≤100 bisection
 * iterations); we recalc on every input change without debouncing.
 * The chart redraw runs on every recalc plus whenever the block is
 * resized (ResizeObserver — Pointer-event resize commits final
 * width/height, but during the drag we redraw on every frame so the
 * chart tracks the block's growing canvas).
 */

// Same min/max bounds as RssBlock — keep widget bounds consistent so
// the canvas doesn't end up with one weirdly-sized exception. Initial
// block is 640x460 (form panel ~260px + chart pane fits in the rest).
const BOUNDS = {
  WIDTH_MIN: 380,
  WIDTH_MAX: 1400,
  HEIGHT_MIN: 320,
  HEIGHT_MAX: 1200,
  X_MIN: 0,
  Y_MIN: 0,
};

export interface MotionBlockProps {
  block: MotionBlockDto;
  onChange: (patch: Partial<MotionBlockDto>) => void;
  onDelete: () => void;
}

export function MotionBlock({ block, onChange, onDelete }: MotionBlockProps) {
  // -------------------------------------------------------- header / drag
  //
  // Same gesture model as RssBlock: pointer-capture during drag, local
  // override for smooth tracking, commit-on-release so useDebouncedSave
  // sees one final value not a stream.
  const [dragOverride, setDragOverride] = useState<{ x: number; y: number } | null>(null);
  const dragOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Form inputs and buttons must stay clickable; only blank header
      // area starts a drag.
      if (target.closest('button, input, a, [data-no-drag]')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragOriginRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        startX: block.x,
        startY: block.y,
      };
      setDragOverride({ x: block.x, y: block.y });
    },
    [block.x, block.y],
  );

  const onHeaderPointerMove = useCallback((e: React.PointerEvent) => {
    const o = dragOriginRef.current;
    if (!o) return;
    const dx = e.clientX - o.pointerX;
    const dy = e.clientY - o.pointerY;
    setDragOverride({
      x: Math.max(BOUNDS.X_MIN, o.startX + dx),
      y: Math.max(BOUNDS.Y_MIN, o.startY + dy),
    });
  }, []);

  const onHeaderPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragOriginRef.current) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      const final = dragOverride;
      dragOriginRef.current = null;
      setDragOverride(null);
      if (final && (final.x !== block.x || final.y !== block.y)) {
        onChange({ x: Math.round(final.x), y: Math.round(final.y) });
      }
    },
    [block.x, block.y, dragOverride, onChange],
  );

  // -------------------------------------------------------- resize handle
  const [resizeOverride, setResizeOverride] =
    useState<{ width: number; height: number } | null>(null);
  const resizeOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      resizeOriginRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        startW: block.width,
        startH: block.height,
      };
      setResizeOverride({ width: block.width, height: block.height });
    },
    [block.width, block.height],
  );

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    const o = resizeOriginRef.current;
    if (!o) return;
    const dw = e.clientX - o.pointerX;
    const dh = e.clientY - o.pointerY;
    setResizeOverride({
      width: clamp(o.startW + dw, BOUNDS.WIDTH_MIN, BOUNDS.WIDTH_MAX),
      height: clamp(o.startH + dh, BOUNDS.HEIGHT_MIN, BOUNDS.HEIGHT_MAX),
    });
  }, []);

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeOriginRef.current) return;
      e.currentTarget.releasePointerCapture(e.pointerId);
      const final = resizeOverride;
      resizeOriginRef.current = null;
      setResizeOverride(null);
      if (final && (final.width !== block.width || final.height !== block.height)) {
        onChange({ width: Math.round(final.width), height: Math.round(final.height) });
      }
    },
    [block.width, block.height, resizeOverride, onChange],
  );

  const effX = dragOverride?.x ?? block.x;
  const effY = dragOverride?.y ?? block.y;
  const effW = resizeOverride?.width ?? block.width;
  const effH = resizeOverride?.height ?? block.height;

  // -------------------------------------------------------- inputs / calc
  //
  // The inputs map is the source of truth: we read from block.inputs,
  // and edits flow back via onChange({ inputs: { ... } }). This keeps
  // the typed parsed value out of state — every input is a string in
  // the DOM, parsed-on-the-fly into a number for the calc.
  //
  // NOTE: we intentionally allow the input fields to render the live
  // string the user is typing (so partial entries like "1." don't
  // get wiped). The DTO stores the parsed number; if the user typed
  // a partial we keep the local "draft" string until the field blurs
  // or a sibling field changes.
  const inputs = block.inputs ?? {};

  const setInput = useCallback(
    (key: string, value: number) => {
      onChange({ inputs: { ...inputs, [key]: value } });
    },
    [inputs, onChange],
  );

  const setShowAcc = useCallback(
    (v: boolean) => onChange({ showAcc: v }),
    [onChange],
  );
  const setShowJerk = useCallback(
    (v: boolean) => onChange({ showJerk: v }),
    [onChange],
  );

  // Local string drafts so partial input ("1." mid-type) doesn't get
  // wiped by a numeric round-trip through the DTO. The draft wins
  // for display; the DTO carries the parsed number for persistence
  // and calc. Drafts are seeded from block.inputs on mount; from
  // there we update them as the user types.
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    seedDrafts(block.mode, inputs),
  );

  const updateField = useCallback(
    (key: string, raw: string) => {
      setDrafts((d) => ({ ...d, [key]: raw }));
      const n = parseNum(raw);
      if (isFinite(n)) {
        setInput(key, n);
      }
    },
    [setInput],
  );

  // Compute the result on every render (cheap; analytic + ≤100 iter).
  const result: MotionResult | null = useMemo(() => {
    return computeForMode(block.mode, inputs);
  }, [block.mode, inputs]);

  // -------------------------------------------------------- chart redraw
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Redraw whenever the result, the toggle states, or the block size
  // changes. We watch effW/effH (the live values during a resize gesture)
  // so the chart fills smoothly while the user drags the corner; final
  // commit just maps to the same width/height a frame later.
  useEffect(() => {
    drawChart(canvasRef.current, result, {
      showAcc: !!block.showAcc,
      showJerk: !!block.showJerk,
    });
  }, [result, block.showAcc, block.showJerk, effW, effH]);

  // ResizeObserver for any other reason the canvas might change size
  // — e.g. browser window resize, sidebar toggle. The above effect
  // covers explicit block resize; this covers everything else.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      drawChart(canvas, result, {
        showAcc: !!block.showAcc,
        showJerk: !!block.showJerk,
      });
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  }, [result, block.showAcc, block.showJerk]);

  // -------------------------------------------------------- mode B helper
  // The "Set min. distance" button replaces the distance input with the
  // smallest D at which the system can actually reach Max Velocity.
  const setMinDistance = useCallback(() => {
    if (block.mode !== 'B') return;
    const aMax = parseNum(inputs.aMax);
    const dMax = parseNum(inputs.dMax);
    const jerk = parseNum(inputs.jerk);
    const vMax = parseNum(inputs.vMax);
    if (!(aMax > 0) || !(dMax > 0) || !(jerk > 0) || !(vMax > 0)) return;
    const minD = minDistanceForVMax(aMax, dMax, jerk, vMax);
    const rounded = Math.round(minD * 10000) / 10000;
    setDrafts((d) => ({ ...d, D: fmt(rounded, 4) }));
    setInput('D', rounded);
  }, [block.mode, inputs, setInput]);

  // -------------------------------------------------------- render
  const headerTitle = MODE_TITLES[block.mode];

  return (
    <div
      className="nc-motion-block"
      style={{ left: effX, top: effY, width: effW, height: effH }}
    >
      <div
        className="nc-motion-block-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className="nc-motion-block-title" title={headerTitle}>
          {headerTitle}
        </span>
        <span className="nc-motion-block-actions" data-no-drag="true">
          <button
            type="button"
            className="nc-motion-block-iconbtn"
            onClick={onDelete}
            title="Delete block"
            aria-label="Delete block"
          >
            ✕
          </button>
        </span>
      </div>

      <div className="nc-motion-block-body">
        <div className="nc-motion-form" data-no-drag="true">
          {block.mode === 'A' && (
            <ModeAFields
              drafts={drafts}
              updateField={updateField}
              dynFrac={(inputs.dynFrac ?? 0.5) * 100}
              accFrac={(inputs.accFrac ?? 0.25) * 100}
              onAccFrac={(pct) => setInput('accFrac', pct / 100)}
              onDynFrac={(pct) => setInput('dynFrac', pct / 100)}
            />
          )}
          {block.mode === 'B' && (
            <ModeBFields
              drafts={drafts}
              updateField={updateField}
              onSetMinDistance={setMinDistance}
            />
          )}
          {block.mode === 'C' && (
            <ModeCFields drafts={drafts} updateField={updateField} />
          )}
        </div>

        <div className="nc-motion-chart-pane" data-no-drag="true">
          <div className="nc-motion-chart-toggles">
            <label>
              <input
                type="checkbox"
                checked={!!block.showAcc}
                onChange={(e) => setShowAcc(e.target.checked)}
              />{' '}
              Show Acceleration
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!block.showJerk}
                onChange={(e) => setShowJerk(e.target.checked)}
              />{' '}
              Show Jerk
            </label>
          </div>
          <canvas ref={canvasRef} className="nc-motion-chart" />
          <div className="nc-motion-results">
            <ResultCells mode={block.mode} result={result} />
          </div>
        </div>
      </div>

      <div
        className="nc-motion-block-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        title="Drag to resize"
        aria-label="Resize block"
      />
    </div>
  );
}

// ============================================================================
// Mode-specific input forms
// ============================================================================

interface ModeAFieldsProps {
  drafts: Record<string, string>;
  updateField: (key: string, raw: string) => void;
  accFrac: number; // percent (1..50)
  dynFrac: number; // percent (0..100)
  onAccFrac: (pct: number) => void;
  onDynFrac: (pct: number) => void;
}

function ModeAFields({
  drafts,
  updateField,
  accFrac,
  dynFrac,
  onAccFrac,
  onDynFrac,
}: ModeAFieldsProps) {
  return (
    <>
      <NumField
        label="Travel time"
        unit="s"
        value={drafts.T ?? ''}
        onChange={(v) => updateField('T', v)}
      />
      <NumField
        label="Distance"
        unit="units"
        value={drafts.D ?? ''}
        onChange={(v) => updateField('D', v)}
      />
      <SliderField
        label="Acc / Dec ratio"
        min={1}
        max={50}
        value={Math.round(accFrac)}
        suffix="%"
        onChange={onAccFrac}
      />
      <SliderField
        label="Dynamic (S-curve sharpness)"
        min={0}
        max={100}
        value={Math.round(dynFrac)}
        suffix="%"
        onChange={onDynFrac}
      />
    </>
  );
}

interface ModeBFieldsProps {
  drafts: Record<string, string>;
  updateField: (key: string, raw: string) => void;
  onSetMinDistance: () => void;
}

function ModeBFields({ drafts, updateField, onSetMinDistance }: ModeBFieldsProps) {
  return (
    <>
      <NumField
        label="Acceleration"
        unit="u/s²"
        value={drafts.aMax ?? ''}
        onChange={(v) => updateField('aMax', v)}
      />
      <NumField
        label="Deceleration"
        unit="u/s²"
        value={drafts.dMax ?? ''}
        onChange={(v) => updateField('dMax', v)}
      />
      <NumField
        label="Jerk"
        unit="u/s³"
        value={drafts.jerk ?? ''}
        onChange={(v) => updateField('jerk', v)}
      />
      <NumField
        label="Distance"
        unit="units"
        value={drafts.D ?? ''}
        onChange={(v) => updateField('D', v)}
      />
      <NumField
        label="Max Velocity"
        unit="u/s"
        value={drafts.vMax ?? ''}
        onChange={(v) => updateField('vMax', v)}
      />
      <div className="nc-motion-form-actions">
        <button
          type="button"
          className="nc-motion-secondary-btn"
          onClick={onSetMinDistance}
        >
          Set min. distance
        </button>
      </div>
    </>
  );
}

interface ModeCFieldsProps {
  drafts: Record<string, string>;
  updateField: (key: string, raw: string) => void;
}

function ModeCFields({ drafts, updateField }: ModeCFieldsProps) {
  return (
    <>
      <NumField
        label="Acceleration"
        unit="u/s²"
        value={drafts.aMax ?? ''}
        onChange={(v) => updateField('aMax', v)}
      />
      <NumField
        label="Deceleration"
        unit="u/s²"
        value={drafts.dMax ?? ''}
        onChange={(v) => updateField('dMax', v)}
      />
      <NumField
        label="Jerk"
        unit="u/s³"
        value={drafts.jerk ?? ''}
        onChange={(v) => updateField('jerk', v)}
      />
      <NumField
        label="Distance"
        unit="units"
        value={drafts.Dmax ?? ''}
        onChange={(v) => updateField('Dmax', v)}
      />
      <NumField
        label="Total Time"
        unit="s"
        value={drafts.Ttot ?? ''}
        onChange={(v) => updateField('Ttot', v)}
      />
    </>
  );
}

// ============================================================================
// Small subcomponents
// ============================================================================

interface NumFieldProps {
  label: string;
  unit: string;
  value: string;
  onChange: (raw: string) => void;
}

function NumField({ label, unit, value, onChange }: NumFieldProps) {
  return (
    <label className="nc-motion-field">
      <span className="nc-motion-field-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="nc-motion-field-unit">{unit}</span>
    </label>
  );
}

interface SliderFieldProps {
  label: string;
  min: number;
  max: number;
  value: number;
  suffix: string;
  onChange: (n: number) => void;
}

function SliderField({ label, min, max, value, suffix, onChange }: SliderFieldProps) {
  return (
    <div className="nc-motion-slider">
      <div className="nc-motion-slider-head">
        <span>{label}</span>
        <span className="nc-motion-slider-val">
          {value} {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
      />
    </div>
  );
}

// Result label rows that vary per mode, pulled out so the main render
// stays readable.
function ResultCells({
  mode,
  result,
}: {
  mode: 'A' | 'B' | 'C';
  result: MotionResult | null;
}) {
  if (mode === 'A') {
    return (
      <>
        <Result lbl="Velocity" val={result?.vPeak} unit="units/s" decimals={1} />
        <Result lbl="Acceleration" val={result?.acc} unit="units/s²" decimals={1} />
        <Result lbl="Deceleration" val={result?.dec} unit="units/s²" decimals={1} />
        <Result lbl="Jerk" val={result?.jerk} unit="units/s³" decimals={1} />
      </>
    );
  }
  if (mode === 'B') {
    return (
      <>
        <Result lbl="Acc Time" val={result?.tAcc} unit="s" decimals={4} />
        <Result lbl="Const. Time" val={result?.tConst} unit="s" decimals={4} />
        <Result lbl="Dec Time" val={result?.tDec} unit="s" decimals={4} />
        <Result lbl="Total Time" val={result?.T} unit="s" decimals={4} />
      </>
    );
  }
  return (
    <>
      <Result lbl="Peak Velocity" val={result?.vPeak} unit="u/s" decimals={4} />
      <Result lbl="Actual Acc" val={result?.acc} unit="u/s²" decimals={2} />
      <Result lbl="Actual Dec" val={result?.dec} unit="u/s²" decimals={2} />
      <Result lbl="Actual Jerk" val={result?.jerk} unit="u/s³" decimals={2} />
    </>
  );
}

function Result({
  lbl,
  val,
  unit,
  decimals,
}: {
  lbl: string;
  val: number | undefined;
  unit: string;
  decimals: number;
}) {
  const display = val == null || !isFinite(val) ? '—' : fmt(val, decimals);
  return (
    <div className="nc-motion-result">
      <span className="nc-motion-result-lbl">{lbl}</span>
      <span className="nc-motion-result-val">{display}</span>
      <span className="nc-motion-result-unit">{unit}</span>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const MODE_TITLES: Record<'A' | 'B' | 'C', string> = {
  A: 'Time → Dynamics',
  B: 'Dynamics → Time',
  C: 'Dynamics + Limits → Velocity',
};

/**
 * Defaults per mode — same as the standalone calculator's <input value="…">.
 * Used both at insert-time (DashboardPage seeds these into the new block's
 * `inputs`) and to seed the local string drafts on mount when the DTO is
 * missing a key.
 */
export const MOTION_DEFAULTS: Record<'A' | 'B' | 'C', Record<string, number>> = {
  A: { T: 2, D: 100, accFrac: 0.25, dynFrac: 0.5 },
  B: { aMax: 20000, dMax: 20000, jerk: 200000, D: 100, vMax: 1000 },
  C: { aMax: 20000, dMax: 20000, jerk: 200000, Dmax: 200, Ttot: 2 },
};

/**
 * Compute a result for any mode. Pulls the right keys out of the DTO's
 * inputs map and dispatches to the mode's calc function. Returns null
 * (just like the standalone calculator) on any invalid/missing input.
 */
function computeForMode(mode: 'A' | 'B' | 'C', inputs: Record<string, number>): MotionResult | null {
  if (mode === 'A') {
    return calculateForward({
      T: inputs.T,
      D: inputs.D,
      accFrac: inputs.accFrac,
      dynFrac: inputs.dynFrac,
    });
  }
  if (mode === 'B') {
    return calculateReverse({
      aMax: inputs.aMax,
      dMax: inputs.dMax,
      jerk: inputs.jerk,
      D: inputs.D,
      vMax: inputs.vMax,
    });
  }
  return calculateThirdMode({
    aMax: inputs.aMax,
    dMax: inputs.dMax,
    jerk: inputs.jerk,
    Dmax: inputs.Dmax,
    Ttot: inputs.Ttot,
  });
}

/**
 * Seed the local-string drafts for the input fields. We render each
 * field's persisted number as a string the user can edit; on mount we
 * format it cleanly (no trailing zeros) so the field doesn't show
 * "20000.0000" for an integer.
 */
function seedDrafts(
  mode: 'A' | 'B' | 'C',
  inputs: Record<string, number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys: string[] =
    mode === 'A'
      ? ['T', 'D']
      : mode === 'B'
      ? ['aMax', 'dMax', 'jerk', 'D', 'vMax']
      : ['aMax', 'dMax', 'jerk', 'Dmax', 'Ttot'];
  for (const k of keys) {
    const v = inputs[k];
    if (v != null && isFinite(v)) {
      // Use plain String(v) — keeps the user's integers as integers and
      // their decimals as decimals without forcing trailing zeros.
      out[k] = String(v);
    } else {
      out[k] = '';
    }
  }
  return out;
}
