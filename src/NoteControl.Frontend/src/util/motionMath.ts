// =============================================================================
// motionMath.ts — Motion-profile S-curve solvers used by the dashboard's
// Motion calculator widgets.
//
// Direct 1:1 port of the standalone PowerCMD BA calculator's motion.js.
// Conventions:
//   - All distances/velocities are in user-defined "units"; time is seconds.
//   - S-curve profile = symmetric jerk-limited ramp.
//   - All three modes return the same shape (`MotionResult`) so the chart
//     and the results block can render any mode uniformly.
//
// This file is calculation-only. The canvas chart that visualises the
// result lives in motionChart.ts.
//
// If this file's formulas ever need to change, update the standalone
// calculator (motion.js) in lockstep — the two are meant to produce
// identical numbers for identical inputs.
// =============================================================================

/** Output of any of the three calculate* functions, plus enough metadata for the chart. */
export interface MotionResult {
  /** Which mode produced this result. 0 = A, 1 = B, 2 = C. */
  mode: 0 | 1 | 2;

  /** Peak (cruise) velocity, units/s. */
  vPeak: number;
  /** Peak acceleration, units/s^2. Mode A: same as `dec`. */
  acc: number;
  /** Peak deceleration, units/s^2. Mode A: same as `acc`. */
  dec: number;
  /** Peak jerk, units/s^3. */
  jerk: number;

  /** Acceleration phase duration, seconds. */
  tAcc: number;
  /** Constant-velocity phase duration, seconds. */
  tConst: number;
  /** Deceleration phase duration, seconds. */
  tDec: number;
  /** Total motion time = tAcc + tConst + tDec, seconds. */
  T: number;

  /**
   * S-curve sharpness factor used by the chart's velocity-shape
   * function. 0 = trapezoid (linear ramps), 0.5 = full S-curve.
   * Derived from the inputs (mode A: from the slider; modes B/C:
   * from the actual jerk-limited shape).
   */
  sfCurve: number;
}

/* -----------------------------------------------------------------------------
 *  S-curve phase: returns {t, d, aActual} for a single accel (or decel)
 *  phase that changes velocity by `dv`, with peak-acc limit `aLim` and
 *  jerk limit `j`.
 * --------------------------------------------------------------------------- */
interface SCurvePhase {
  t: number;
  d: number;
  aActual: number;
}

export function sCurvePhase(dv: number, aLim: number, j: number): SCurvePhase {
  const tj = aLim / j;
  if (dv >= (aLim * aLim) / j) {
    // Trapezoidal-acc shape: ramp up, flat at aLim, ramp down.
    const ta = dv / aLim - tj;
    const tPhase = 2 * tj + ta;
    const dPhase = (dv * tPhase) / 2.0;
    return { t: tPhase, d: dPhase, aActual: aLim };
  } else {
    // Triangular-acc shape: never reaches aLim.
    const aPeak = Math.sqrt(dv * j);
    const tjNew = aPeak / j;
    const tPhase = 2 * tjNew;
    const dPhase = (dv * tPhase) / 2.0;
    return { t: tPhase, d: dPhase, aActual: aPeak };
  }
}

/* -----------------------------------------------------------------------------
 *  Mode A — Time + Distance + sliders → Dynamics
 * --------------------------------------------------------------------------- */
export interface ModeAInput {
  /** Travel time in seconds. */
  T: number;
  /** Total distance in units. */
  D: number;
  /** Acc/Dec ratio as a fraction in [0..1]. UI slider is 1..50%. */
  accFrac: number;
  /** S-curve sharpness as a fraction in [0..1]. UI slider is 0..100%. */
  dynFrac: number;
}

export function calculateForward(input: ModeAInput): MotionResult | null {
  const { T, D, accFrac, dynFrac } = input;

  if (!(T > 0) || !(D > 0)) return null;

  const tAcc = Math.min(accFrac * T, T * 0.5);
  const tDec = tAcc;
  const tConst = Math.max(T - tAcc - tDec, 0);

  const vPeak = D / (0.5 * tAcc + tConst + 0.5 * tDec);
  const acc = tAcc > 0 ? vPeak / tAcc : 0;
  const jerk = tAcc > 0 ? acc / Math.max(dynFrac * tAcc, 0.001) : 0;

  // Slider 0..1 maps to S-curve sf 0..0.5. Same mapping as the
  // standalone calculator; see SCurveVelocity() below.
  const sfCurve = dynFrac * 0.5;

  return {
    mode: 0,
    vPeak,
    acc,
    dec: acc,
    jerk,
    tAcc,
    tConst,
    tDec,
    T,
    sfCurve,
  };
}

/* -----------------------------------------------------------------------------
 *  Mode B — Dynamics + Distance + Max Velocity → Times
 * --------------------------------------------------------------------------- */
export interface ModeBInput {
  aMax: number;
  dMax: number;
  jerk: number;
  D: number;
  vMax: number;
}

export function calculateReverse(input: ModeBInput): MotionResult | null {
  const { aMax, dMax, jerk, D, vMax } = input;

  if (!(aMax > 0) || !(dMax > 0) || !(jerk > 0) || !(D > 0) || !(vMax > 0)) return null;

  const accFull = sCurvePhase(vMax, aMax, jerk);
  const decFull = sCurvePhase(vMax, dMax, jerk);

  let vPeak: number;
  let tAcc: number;
  let tDec: number;
  let aAcc: number;
  let aDec: number;
  let tConst: number;

  if (accFull.d + decFull.d > D) {
    // Distance too short to reach vMax — bisect on vPeak.
    let lo = 0;
    let hi = vMax;
    for (let iter = 0; iter < 60; iter++) {
      const mid = (lo + hi) * 0.5;
      const a = sCurvePhase(mid, aMax, jerk);
      const d = sCurvePhase(mid, dMax, jerk);
      if (a.d + d.d < D) lo = mid;
      else hi = mid;
    }
    vPeak = (lo + hi) * 0.5;
    const a = sCurvePhase(vPeak, aMax, jerk);
    const d = sCurvePhase(vPeak, dMax, jerk);
    tAcc = a.t;
    aAcc = a.aActual;
    tDec = d.t;
    aDec = d.aActual;
    tConst = 0;
  } else {
    vPeak = vMax;
    tAcc = accFull.t;
    aAcc = accFull.aActual;
    tDec = decFull.t;
    aDec = decFull.aActual;
    tConst = (D - accFull.d - decFull.d) / vMax;
  }

  const T = tAcc + tConst + tDec;
  const tjAcc = aAcc / jerk;
  const sfCurve = tAcc > 0 ? Math.min(tjAcc / tAcc, 0.5) : 0;

  return {
    mode: 1,
    vPeak,
    acc: aAcc,
    dec: aDec,
    jerk,
    tAcc,
    tConst,
    tDec,
    T,
    sfCurve,
  };
}

/**
 * Mode B helper — minimum distance to reach vMax with given dynamics.
 * Returns the smallest D at which the system can actually hit vMax
 * (i.e. acc-phase distance + dec-phase distance, no cruise needed).
 */
export function minDistanceForVMax(aMax: number, dMax: number, jerk: number, vMax: number): number {
  function sCurveDist(dv: number, aLim: number, j: number): number {
    if (dv >= (aLim * aLim) / j) {
      const tj = aLim / j;
      const ta = dv / aLim - tj;
      const tTot = 2 * tj + ta;
      return (dv * tTot) / 2.0;
    } else {
      const tjNew = Math.sqrt(dv / j);
      return dv * tjNew;
    }
  }
  return sCurveDist(vMax, aMax, jerk) + sCurveDist(vMax, dMax, jerk);
}

/* -----------------------------------------------------------------------------
 *  Mode C — Dynamics + Distance + Total Time → Optimal Peak Velocity
 *  Approach: binary search on vPeak; both time AND distance must fit.
 * --------------------------------------------------------------------------- */
export interface ModeCInput {
  aMax: number;
  dMax: number;
  jerk: number;
  Dmax: number;
  Ttot: number;
}

export function calculateThirdMode(input: ModeCInput): MotionResult | null {
  const { aMax, dMax, jerk, Dmax, Ttot } = input;

  if (!(aMax > 0) || !(dMax > 0) || !(jerk > 0) || !(Dmax > 0) || !(Ttot > 0)) return null;

  interface Probe {
    tA: number;
    aA: number;
    tD: number;
    aD: number;
    tC: number;
    fits: boolean;
  }

  function probe(v: number): Probe {
    const a = sCurvePhase(v, aMax, jerk);
    const d = sCurvePhase(v, dMax, jerk);
    const tC = Math.max(0, Ttot - a.t - d.t);
    const dist = a.d + v * tC + d.d;
    const fits = a.t + d.t <= Ttot && dist <= Dmax;
    return { tA: a.t, aA: a.aActual, tD: d.t, aD: d.aActual, tC, fits };
  }

  // Upper bound: same heuristic as the original (jerk * (T/2)^2 * 4).
  let hi = jerk * (Ttot / 2.0) * (Ttot / 2.0) * 4;
  let lo = 0;
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) * 0.5;
    if (probe(mid).fits) lo = mid;
    else hi = mid;
  }
  const vPeak = lo;
  const r = probe(vPeak);

  const tjAcc = r.aA / jerk;
  const sfCurve = r.tA > 0 ? Math.min(tjAcc / r.tA, 0.5) : 0;
  const T = r.tA + r.tC + r.tD;

  return {
    mode: 2,
    vPeak,
    acc: r.aA,
    dec: r.aD,
    jerk,
    tAcc: r.tA,
    tConst: r.tC,
    tDec: r.tD,
    T,
    sfCurve,
  };
}

/* -----------------------------------------------------------------------------
 *  S-curve normalised velocity — used by the chart only, exported for
 *  reuse in tests and any future client-side simulation.
 * --------------------------------------------------------------------------- */

/**
 * S-curve normalised velocity 0..1 over normalised time p=0..1.
 * `sf` = fraction of phase in each jerk ramp:
 *   - 0   → trapezoid (linear velocity ramp)
 *   - 0.5 → full S-curve
 */
export function sCurveVelocity(p: number, sf: number): number {
  p = Math.max(0.0, Math.min(1.0, p));
  if (sf <= 0.0) return p;

  const tj = Math.min(sf, 0.5);
  const ta = 1.0 - 2.0 * tj;
  const denom = 2.0 * tj * (1.0 - tj);
  if (denom < 1e-12) return p;

  let v: number;
  if (p <= tj) {
    v = (p * p) / denom;
  } else if (p <= tj + ta) {
    const v_at_tj = (tj * tj) / denom;
    const a_norm = 1.0 / (1.0 - tj);
    v = v_at_tj + a_norm * (p - tj);
  } else {
    const q = 1.0 - p;
    v = 1.0 - (q * q) / denom;
  }
  return Math.max(0.0, Math.min(1.0, v));
}

/** Velocity at time t given the result's tAcc / tConst / tDec / vPeak / sf / T. */
export function velocityAt(
  t: number,
  tAcc: number,
  tConst: number,
  tDec: number,
  vPeak: number,
  sf: number,
  T: number,
): number {
  if (t <= 0 || t >= T) return 0;
  const t1 = tAcc;
  const t2 = tAcc + tConst;
  if (t <= t1) {
    if (tAcc <= 0) return vPeak;
    return vPeak * sCurveVelocity(t / tAcc, sf);
  }
  if (t <= t2) return vPeak;
  if (tDec <= 0) return 0;
  return vPeak * (1.0 - sCurveVelocity((t - t2) / tDec, sf));
}

/** Build a 501-point velocity profile for charting. */
export function buildProfile(
  tAcc: number,
  tConst: number,
  tDec: number,
  vPeak: number,
  sf: number,
  T: number,
): { t: number; v: number }[] {
  const pts = new Array(501);
  for (let i = 0; i <= 500; i++) {
    const t = (i / 500.0) * T;
    let v = velocityAt(t, tAcc, tConst, tDec, vPeak, sf, T);
    if (!isFinite(v)) v = 0;
    v = Math.max(0, Math.min(vPeak * 2, v));
    pts[i] = { t, v };
  }
  return pts;
}

/* -----------------------------------------------------------------------------
 *  Number formatting / parsing — match the standalone calculator so the
 *  result strings line up byte-for-byte for the same inputs.
 * --------------------------------------------------------------------------- */

/** Round to `dec` decimals; "—" for non-finite. */
export function fmt(v: number, dec = 1): string {
  if (!isFinite(v)) return '—';
  const f = Math.pow(10, dec);
  return (Math.round(v * f) / f).toString();
}

/**
 * Parse a numeric input string. Tolerates decimal commas (Danish/European
 * keyboards) by swapping the first comma for a dot. Returns NaN for empty
 * or bad input — callers check with isFinite/positive guards.
 */
export function parseNum(str: string | number | null | undefined): number {
  if (str == null) return NaN;
  if (typeof str === 'number') return str;
  return parseFloat(String(str).trim().replace(',', '.'));
}
