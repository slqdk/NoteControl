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

  /**
   * Update just the visible draft string for a field — without touching
   * the DTO. Used when a derived value (like the auto-coupled motor speed
   * in Mode D) changes from outside the input flow and we want the
   * field to reflect the new value. Don't use this for user typing —
   * use updateField for that, which also parses and writes to the DTO.
   */
  const setDraft = useCallback((key: string, raw: string) => {
    setDrafts((d) => (d[key] === raw ? d : { ...d, [key]: raw }));
  }, []);

  // Compute the result on every render (cheap; analytic + ≤100 iter).
  const result: MotionResult | null = useMemo(() => {
    return computeForMode(block.mode, inputs);
  }, [block.mode, inputs]);

  // Mode D — derive the motor-side RPMs from the profile + mechanicals.
  // Returns NaN when inputs aren't enough; the UI then shows "—".
  // Conventions (matching BADK_Motion_Setup_Tool's MotorMath.cs):
  //   gearRatio = motor_rev / output_rev (motor faster than output for i>1)
  //   motor_rpm = (load_velocity / feedConstant) × gearRatio × 60
  // Avg motor RPM uses average load velocity (D/T, including ramps); peak
  // uses vPeak from the calc result.
  const motorRpmFromProfile = useMemo(() => {
    if (block.mode !== 'D') return { peak: NaN, avg: NaN };
    const feed = inputs.feedConstant;
    const gr = inputs.gearRatio;
    if (!(feed > 0) || !(gr > 0)) return { peak: NaN, avg: NaN };
    const T = inputs.T;
    const D = inputs.D;
    const peakVel = result?.vPeak ?? NaN;
    const avgVel = T > 0 && D > 0 ? D / T : NaN;
    return {
      peak: isFinite(peakVel) ? (peakVel / feed) * gr * 60 : NaN,
      avg: isFinite(avgVel) ? (avgVel / feed) * gr * 60 : NaN,
    };
  }, [block.mode, inputs, result]);

  // Mode D — the "displayed" motor speed: user's manual override wins
  // when block.manualMotorSpeed is true; otherwise the profile's
  // computed peak. Peak RPM in the results uses this same source so
  // the chart's red-when-exceeded check (a future improvement) and the
  // displayed value can never disagree.
  const effectiveMotorRpmPeak =
    block.mode === 'D' && block.manualMotorSpeed
      ? // User's manualSpeed value is ALREADY in motor RPM (the motor-side
        // text input shows rpm directly), so no conversion needed.
        inputs.motorSpeed
      : motorRpmFromProfile.peak;

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
          {block.mode === 'D' && (
            <ModeDFields
              block={block}
              drafts={drafts}
              updateField={updateField}
              setDraft={setDraft}
              accFrac={(inputs.accFrac ?? 0.25) * 100}
              dynFrac={(inputs.dynFrac ?? 0.5) * 100}
              onAccFrac={(pct) => setInput('accFrac', pct / 100)}
              onDynFrac={(pct) => setInput('dynFrac', pct / 100)}
              result={result}
              onChange={onChange}
            />
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
          <div
            className={
              'nc-motion-results' +
              (block.mode === 'D' ? ' nc-motion-results-six' : '')
            }
          >
            <ResultCells
              mode={block.mode}
              result={result}
              motorRpmPeak={effectiveMotorRpmPeak}
              motorRpmAvg={motorRpmFromProfile.avg}
            />
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
// Mode D — Motor / Gear + Time → Dynamics
// ============================================================================
//
// Layout:
//   - Top row: a "Calculate motor / gear" panel (mechanical inputs +
//     motor side + gear side, with bidirectional auto-sync between
//     the two sides whenever any motor/gear value changes).
//   - Below it: the standard Mode-A "Calculate the best motion profile"
//     form (T, D, accFrac slider, dynFrac slider).
//
// Auto-sync rules:
//   - The motor side speed/torque normally tracks the motion profile +
//     the gear ratio. The user can OVERRIDE either by typing into the
//     motor-side fields; we record manualMotorSpeed / manualMotorTorque
//     so the auto-update doesn't clobber them on the next slider tick.
//     A "↺" reset button next to each manually-edited field re-couples
//     it to the profile.
//   - The gear side is always derived. Editing it pushes back through
//     the gear ratio to the motor side (and that becomes manual).
//
// Sync directions per Form1.cs (with the rpm-vs-torque-direction bug
// from the original C# corrected here):
//   gear_speed  = motor_speed / gearRatio        (motor faster)
//   motor_speed = gear_speed  * gearRatio
//   gear_torque = motor_torque * gearRatio       (gear has more torque)
//   motor_torque= gear_torque  / gearRatio
//
// Current is read-only: I = motor_torque / torque_constant.

interface ModeDFieldsProps {
  block: MotionBlockDto;
  drafts: Record<string, string>;
  updateField: (key: string, raw: string) => void;
  setDraft: (key: string, raw: string) => void;
  accFrac: number; // percent
  dynFrac: number; // percent
  onAccFrac: (pct: number) => void;
  onDynFrac: (pct: number) => void;
  result: MotionResult | null;
  onChange: (patch: Partial<MotionBlockDto>) => void;
}

function ModeDFields({
  block,
  drafts,
  updateField,
  setDraft,
  accFrac,
  dynFrac,
  onAccFrac,
  onDynFrac,
  result,
  onChange,
}: ModeDFieldsProps) {
  const inputs = block.inputs ?? {};
  const gr = inputs.gearRatio;
  const feed = inputs.feedConstant;
  const torqueK = inputs.torqueConstant;

  // ----- Auto-fill motor side from the motion profile when not manual.
  //
  // Effect mirrors the BADK tool's UpdateMotorRPM: whenever the profile
  // result changes, push the new motor speed into the DTO and into the
  // visible draft strings (otherwise the user would see stale text in
  // the input boxes). We re-read `block.inputs` at fire-time (not via
  // the closure-captured `inputs`) because the closure could be stale —
  // typing in one field then in another could otherwise overwrite the
  // second edit with the first edit's snapshot.
  useEffect(() => {
    if (block.manualMotorSpeed) return;
    if (!(feed > 0) || !(gr > 0)) return;
    const peakVel = result?.vPeak;
    if (peakVel == null || !isFinite(peakVel)) return;
    const motorRpm = (peakVel / feed) * gr * 60;
    const fresh = block.inputs ?? {};
    if (Math.abs(motorRpm - (fresh.motorSpeed ?? 0)) < 1e-6) return;
    onChange({
      inputs: {
        ...fresh,
        motorSpeed: motorRpm,
        // Keep the gear side in sync as well — gear_speed = motor / i
        gearSpeed: motorRpm / gr,
      },
    });
    // Reflect the new values in the visible input boxes too. Use a
    // stable formatter so the field doesn't show "3000.0000000000004"
    // type artefacts when the math passes through a multiply+divide.
    setDraft('motorSpeed', fmt(motorRpm, 2));
    setDraft('gearSpeed', fmt(motorRpm / gr, 2));
  // We DON'T list `block.inputs` or `inputs` in deps — they change on
  // every keystroke and would loop. Instead we re-key on the actual
  // drivers. ESLint would flag this, but the dependency set is correct:
  // result.vPeak, feed, gr, manual flag.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.vPeak, feed, gr, block.manualMotorSpeed]);

  // ----- Manual motor-side edits: mark manual, then push to gear side.
  //
  // We bundle both fields into a single onChange so React batches the
  // update; calling setInput twice in sequence would race because each
  // spread uses the same captured inputs snapshot, and only the second
  // call's spread would survive. One write, both fields, no race.
  function onMotorSpeedEdit(raw: string) {
    updateField('motorSpeed', raw);
    const n = parseNum(raw);
    const fresh = block.inputs ?? {};
    if (isFinite(n) && gr > 0) {
      onChange({
        inputs: { ...fresh, motorSpeed: n, gearSpeed: n / gr },
        ...(block.manualMotorSpeed ? {} : { manualMotorSpeed: true }),
      });
    } else if (!block.manualMotorSpeed) {
      onChange({ manualMotorSpeed: true });
    }
  }

  function onGearSpeedEdit(raw: string) {
    updateField('gearSpeed', raw);
    const n = parseNum(raw);
    const fresh = block.inputs ?? {};
    if (isFinite(n) && gr > 0) {
      // Editing the gear side also breaks the auto-couple from the
      // motion profile — the user has expressed intent.
      onChange({
        inputs: { ...fresh, gearSpeed: n, motorSpeed: n * gr },
        ...(block.manualMotorSpeed ? {} : { manualMotorSpeed: true }),
      });
    } else if (!block.manualMotorSpeed) {
      onChange({ manualMotorSpeed: true });
    }
  }

  function onMotorTorqueEdit(raw: string) {
    updateField('motorTorque', raw);
    const n = parseNum(raw);
    const fresh = block.inputs ?? {};
    if (isFinite(n) && gr > 0) {
      onChange({
        inputs: { ...fresh, motorTorque: n, gearTorque: n * gr },
      });
    }
  }

  function onGearTorqueEdit(raw: string) {
    updateField('gearTorque', raw);
    const n = parseNum(raw);
    const fresh = block.inputs ?? {};
    if (isFinite(n) && gr > 0) {
      onChange({
        inputs: { ...fresh, gearTorque: n, motorTorque: n / gr },
      });
    }
  }

  function resetMotorSpeedToProfile() {
    onChange({ manualMotorSpeed: false });
  }

  // Read-only computed: motor current = motor torque / torque constant.
  const motorCurrent =
    isFinite(inputs.motorTorque) && torqueK > 0
      ? inputs.motorTorque / torqueK
      : NaN;

  return (
    <>
      <div className="nc-motion-d-section">
        <h3 className="nc-motion-d-section-title">Calculate motor / gear</h3>
        <div className="nc-motion-d-mech">
          <NumField
            label="Gear Ratio"
            unit="i"
            value={drafts.gearRatio ?? ''}
            onChange={(v) => updateField('gearRatio', v)}
          />
          <NumField
            label="Torque Constant"
            unit="Nm/A"
            value={drafts.torqueConstant ?? ''}
            onChange={(v) => updateField('torqueConstant', v)}
          />
          <NumField
            label="Feed Constant"
            unit="units/rev"
            value={drafts.feedConstant ?? ''}
            onChange={(v) => updateField('feedConstant', v)}
          />
        </div>
        <div className="nc-motion-d-sides">
          <div className="nc-motion-d-side">
            <div className="nc-motion-d-side-title">Motor side</div>
            <NumFieldWithReset
              label="Speed"
              unit="rpm"
              value={drafts.motorSpeed ?? ''}
              isManual={!!block.manualMotorSpeed}
              onChange={onMotorSpeedEdit}
              onReset={resetMotorSpeedToProfile}
            />
            <NumField
              label="Torque"
              unit="Nm"
              value={drafts.motorTorque ?? ''}
              onChange={onMotorTorqueEdit}
            />
            <ReadonlyField
              label="Current"
              unit="A"
              value={isFinite(motorCurrent) ? motorCurrent : null}
              decimals={3}
            />
          </div>
          <div className="nc-motion-d-side">
            <div className="nc-motion-d-side-title">Gear side</div>
            <NumField
              label="Speed"
              unit="rpm"
              value={drafts.gearSpeed ?? ''}
              onChange={onGearSpeedEdit}
            />
            <NumField
              label="Torque"
              unit="Nm"
              value={drafts.gearTorque ?? ''}
              onChange={onGearTorqueEdit}
            />
          </div>
        </div>
      </div>
      <div className="nc-motion-d-section">
        <h3 className="nc-motion-d-section-title">Calculate the best motion profile</h3>
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
      </div>
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

interface NumFieldWithResetProps {
  label: string;
  unit: string;
  value: string;
  isManual: boolean;
  onChange: (raw: string) => void;
  onReset: () => void;
}

/**
 * Same as NumField but with a small "↺" reset button visible when the
 * field is in "manual override" mode. Clicking reset goes back to
 * auto-coupled-to-profile. Used for Mode D's motor-side speed/torque.
 */
function NumFieldWithReset({
  label,
  unit,
  value,
  isManual,
  onChange,
  onReset,
}: NumFieldWithResetProps) {
  return (
    <label className={'nc-motion-field' + (isManual ? ' nc-motion-field-manual' : '')}>
      <span className="nc-motion-field-label">
        {label}
        {isManual && (
          <button
            type="button"
            className="nc-motion-reset-btn"
            onClick={(e) => {
              // Stop the click bubbling to the surrounding <label> which
              // would otherwise refocus the input — undesirable when the
              // user is just clicking reset.
              e.preventDefault();
              e.stopPropagation();
              onReset();
            }}
            title="Reset to profile-derived value"
            aria-label="Reset to profile-derived value"
          >
            ↺
          </button>
        )}
      </span>
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

interface ReadonlyFieldProps {
  label: string;
  unit: string;
  value: number | null;
  decimals: number;
}

/** Greyed-out display of a derived value (e.g. motor current). */
function ReadonlyField({ label, unit, value, decimals }: ReadonlyFieldProps) {
  const display = value == null ? '—' : fmt(value, decimals);
  return (
    <div className="nc-motion-field nc-motion-field-readonly">
      <span className="nc-motion-field-label">{label}</span>
      <input type="text" value={display} disabled readOnly />
      <span className="nc-motion-field-unit">{unit}</span>
    </div>
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
  motorRpmPeak,
  motorRpmAvg,
}: {
  mode: 'A' | 'B' | 'C' | 'D';
  result: MotionResult | null;
  motorRpmPeak?: number;
  motorRpmAvg?: number;
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
  if (mode === 'C') {
    return (
      <>
        <Result lbl="Peak Velocity" val={result?.vPeak} unit="u/s" decimals={4} />
        <Result lbl="Actual Acc" val={result?.acc} unit="u/s²" decimals={2} />
        <Result lbl="Actual Dec" val={result?.dec} unit="u/s²" decimals={2} />
        <Result lbl="Actual Jerk" val={result?.jerk} unit="u/s³" decimals={2} />
      </>
    );
  }
  // Mode D — six cells: motion (4) + motor RPM (2). The 2-up CSS grid
  // wraps these to a 3x2 layout when narrow.
  return (
    <>
      <Result lbl="Velocity" val={result?.vPeak} unit="units/s" decimals={2} />
      <Result lbl="Acceleration" val={result?.acc} unit="units/s²" decimals={2} />
      <Result lbl="Deceleration" val={result?.dec} unit="units/s²" decimals={2} />
      <Result lbl="Jerk" val={result?.jerk} unit="units/s³" decimals={2} />
      <Result lbl="Avg motor speed" val={motorRpmAvg} unit="rpm" decimals={2} />
      <Result lbl="Max motor speed" val={motorRpmPeak} unit="rpm" decimals={2} />
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

const MODE_TITLES: Record<'A' | 'B' | 'C' | 'D', string> = {
  A: 'Time → Dynamics',
  B: 'Dynamics → Time',
  C: 'Dynamics + Limits → Velocity',
  D: 'Motor / Gear · Time → Dynamics',
};

/**
 * Defaults per mode — same as the standalone calculator's <input value="…">.
 * Used both at insert-time (DashboardPage seeds these into the new block's
 * `inputs`) and to seed the local string drafts on mount when the DTO is
 * missing a key.
 *
 * Mode D combines:
 *   - The same Mode-A motion inputs (T, D, accFrac, dynFrac).
 *   - Mechanical inputs (gearRatio, feedConstant, torqueConstant).
 *   - Motor side (motorSpeed, motorTorque) — auto-filled from the motion
 *     profile but user-overridable; the manualMotorSpeed/Torque flags
 *     in the DTO record whether the user has taken control.
 *   - Gear side (gearSpeed, gearTorque) — derived from motor side via
 *     the gear ratio; bidirectional so editing the gear side updates
 *     the motor side too.
 */
export const MOTION_DEFAULTS: Record<'A' | 'B' | 'C' | 'D', Record<string, number>> = {
  A: { T: 2, D: 100, accFrac: 0.25, dynFrac: 0.5 },
  B: { aMax: 20000, dMax: 20000, jerk: 200000, D: 100, vMax: 1000 },
  C: { aMax: 20000, dMax: 20000, jerk: 200000, Dmax: 200, Ttot: 2 },
  D: {
    // Motion (Mode-A formula reused)
    T: 1,
    D: 200,
    accFrac: 0.25,
    dynFrac: 0.5,
    // Mechanical
    gearRatio: 1,
    feedConstant: 360,
    torqueConstant: 1,
    // Motor side — start auto-computed by leaving blank-ish defaults;
    // the form fills these from the profile on first render. Stored
    // values let manual edits round-trip across reloads.
    motorSpeed: 3000,
    motorTorque: 1,
    gearSpeed: 3000,
    gearTorque: 1,
  },
};

/**
 * Compute a result for any mode. Pulls the right keys out of the DTO's
 * inputs map and dispatches to the mode's calc function. Returns null
 * (just like the standalone calculator) on any invalid/missing input.
 */
function computeForMode(mode: 'A' | 'B' | 'C' | 'D', inputs: Record<string, number>): MotionResult | null {
  if (mode === 'A' || mode === 'D') {
    // Mode D reuses the Mode-A formula for the motion-profile half; the
    // motor/gear panel sits above the same calc. Identical math.
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
  mode: 'A' | 'B' | 'C' | 'D',
  inputs: Record<string, number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keys: string[] =
    mode === 'A'
      ? ['T', 'D']
      : mode === 'B'
      ? ['aMax', 'dMax', 'jerk', 'D', 'vMax']
      : mode === 'C'
      ? ['aMax', 'dMax', 'jerk', 'Dmax', 'Ttot']
      : // Mode D — every editable text field across both panels.
        // Sliders aren't drafted (they live in the slider state).
        [
          'T',
          'D',
          'gearRatio',
          'feedConstant',
          'torqueConstant',
          'motorSpeed',
          'motorTorque',
          'gearSpeed',
          'gearTorque',
        ];
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
