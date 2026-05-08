// =============================================================================
// motionChart.ts — Canvas-based velocity profile chart for the Motion
// calculator widgets. Draws the velocity curve plus optional acceleration
// and jerk overlays.
//
// Direct port of the standalone PowerCMD BA calculator's drawChart().
// The colour palette is hard-coded (the standalone tool's palette), not
// themed via CSS variables, so the chart looks identical to the original
// and to the desktop tool. If we later want this themed for dark mode,
// thread a `colors` arg through here — but that's a deliberate choice,
// not a refactor away from a mistake.
// =============================================================================

import { buildProfile, fmt, type MotionResult } from './motionMath';

export interface ChartOptions {
  showAcc: boolean;
  showJerk: boolean;
}

export function drawChart(
  canvas: HTMLCanvasElement | null,
  result: MotionResult | null,
  opts: ChartOptions,
): void {
  if (!canvas || !result) return;
  if (!(result.T > 0) || !(result.vPeak > 0)) {
    const ctx0 = canvas.getContext('2d');
    if (ctx0) ctx0.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Hi-DPI support: draw at devicePixelRatio so the line stays crisp on
  // 4K monitors without us losing the CSS-pixel coordinate space.
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  // Canvas with zero CSS size happens briefly during mount or while the
  // block is being created — skip rather than throw on division-by-zero.
  if (cssW <= 0 || cssH <= 0) return;
  if (
    canvas.width !== Math.round(cssW * dpr) ||
    canvas.height !== Math.round(cssH * dpr)
  ) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const W = cssW;
  const H = cssH;
  const padL = 58;
  const padR = 16;
  const padT = 16;
  const padB = 36;
  const cW = W - padL - padR;
  const cH = H - padT - padB;
  if (cW <= 0 || cH <= 0) return;

  const tTotal = result.T;
  const vMax = result.vPeak;
  const tAcc = result.tAcc;
  const tConst = result.tConst;
  const tDec = result.tDec;
  const peakAcc = opts.showAcc ? result.acc : 0;
  const peakJerk = opts.showJerk ? result.jerk : 0;

  const profile = buildProfile(tAcc, tConst, tDec, vMax, result.sfCurve, tTotal);

  // ── grid + labels ────────────────────────────────────────────────────────
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgb(220,230,242)';
  ctx.fillStyle = 'rgb(105,115,130)';
  ctx.font = '10px "JetBrains Mono", "Source Code Pro", ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 5; i++) {
    const y = padT + (cH * i) / 5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cW, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(fmt((vMax * (5 - i)) / 5.0, 0), padL - 6, y);
  }
  for (let i = 0; i <= 8; i++) {
    const x = padL + (cW * i) / 8;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + cH);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(fmt((tTotal * i) / 8.0, 2), x, padT + cH + 6);
    ctx.textBaseline = 'middle';
  }

  // ── axes ─────────────────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgb(100,116,139)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + cH + 1);
  ctx.moveTo(padL - 1, padT + cH);
  ctx.lineTo(padL + cW, padT + cH);
  ctx.stroke();

  ctx.fillStyle = 'rgb(100,116,139)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('v (u/s)', 4, padT - 2);
  ctx.textAlign = 'right';
  ctx.fillText('t (s)', padL + cW, padT + cH + 20);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // ── velocity fill ────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(padL, padT + cH);
  for (const p of profile) {
    const x = padL + (p.t / tTotal) * cW;
    const y = padT + cH - (p.v / vMax) * cH;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(padL + cW, padT + cH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(41,128,185,0.16)';
  ctx.fill();

  // ── velocity stroke ──────────────────────────────────────────────────────
  ctx.beginPath();
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    const x = padL + (p.t / tTotal) * cW;
    const y = padT + cH - (p.v / vMax) * cH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgb(41,128,185)';
  ctx.stroke();

  // helper: map a value in [-peak..+peak] to chart Y (zero at mid-chart)
  function toY(val: number, peak: number): number {
    if (peak <= 0) return padT + cH / 2;
    const norm = (val + peak) / (2.0 * peak);
    return padT + cH - norm * cH;
  }

  // ── acceleration overlay (dashed red) ────────────────────────────────────
  if (peakAcc > 0 && tAcc > 0) {
    const N = 500;
    const tConst2 = tAcc + tConst;
    const dt = tTotal / N;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = i * dt;
      let a = 0;
      if (t < tAcc) {
        a = peakAcc * Math.sin((Math.PI * t) / tAcc);
      } else if (t >= tConst2 && tDec > 0) {
        a = -peakAcc * Math.sin((Math.PI * (t - tConst2)) / tDec);
      }
      const x = padL + (t / tTotal) * cW;
      const y = toY(a, peakAcc);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(192,0,0,0.82)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── jerk overlay (dotted green) ──────────────────────────────────────────
  if (peakJerk > 0 && tAcc > 0) {
    const N = 1000;
    const tConst2 = tAcc + tConst;
    const dt = tTotal / N;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const t = i * dt;
      let j = 0;
      if (t < tAcc && tAcc > 0) {
        j = peakJerk * Math.cos((Math.PI * t) / tAcc);
      } else if (t >= tConst2 && tDec > 0) {
        j = -peakJerk * Math.cos((Math.PI * (t - tConst2)) / tDec);
      }
      const x = padL + (t / tTotal) * cW;
      const y = toY(j, peakJerk);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 1.6;
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(0,150,80,0.78)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── legend ───────────────────────────────────────────────────────────────
  const legX = padL + 8;
  const legY = padT + cH + 22;
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgb(41,128,185)';
  ctx.beginPath();
  ctx.moveTo(legX, legY);
  ctx.lineTo(legX + 20, legY);
  ctx.stroke();
  ctx.fillStyle = 'rgb(100,116,139)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('Velocity', legX + 26, legY);

  let legOffset = 90;
  if (peakAcc > 0) {
    const lx = legX + legOffset;
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(192,0,0,0.82)';
    ctx.beginPath();
    ctx.moveTo(lx, legY);
    ctx.lineTo(lx + 20, legY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgb(192,0,0)';
    ctx.fillText('Acceleration', lx + 26, legY);
    legOffset += 110;
  }
  if (peakJerk > 0) {
    const lx = legX + legOffset;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(0,150,80,0.78)';
    ctx.beginPath();
    ctx.moveTo(lx, legY);
    ctx.lineTo(lx + 20, legY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgb(0,140,70)';
    ctx.fillText('Jerk', lx + 26, legY);
  }
}
