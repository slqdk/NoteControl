import { useEffect, useRef, useState } from 'react';

import {
  ALL_VARIANTS,
  VARIANT_LABELS,
  type TreeVariant,
} from '../tree/treeStyles';
import {
  APP_WIDTH_MAX,
  APP_WIDTH_MIN,
  APP_WIDTH_STEP,
  GRADIENT_PRESETS,
  useAppearance,
} from '../settings/appearance';
import { useTreeBehaviour } from '../settings/treeBehaviour';

export interface ToggleRailButtonsProps {
  treeVisible: boolean;
  propsVisible: boolean;
  onToggleTree: () => void;
  onToggleProps: () => void;
  variant: TreeVariant;
  onVariantChange: (v: TreeVariant) => void;
}

/**
 * Three little buttons that live in the TopBar:
 *   - 📁 toggle tree rail
 *   - ℹ️ toggle properties rail
 *   - ⚙️ open settings popover
 *
 * The settings popover hosts:
 *   - tree style picker (compact / comfortable)
 *   - tree-click behaviour (whole-row vs chevron-only)  ← step 36
 *   - app-width slider (controls the centered .nc-app-frame)
 *   - background gradient grid
 *
 * All settings are global (per-browser, in localStorage).
 *
 * Slider behaviour: while you drag, only the popover's local draft
 * value changes; the actual app frame width is updated on release
 * (pointerup / change / blur). Without that, every onInput tick
 * resizes the topbar, which shifts the cog popover under the
 * cursor — it would feel like the slider is fleeing your mouse.
 * Commit-on-release also makes keyboard arrows feel like discrete
 * steps rather than a continuous resize blur.
 *
 * No "Save" button — every other change applies + persists on the
 * spot, like Notion or VS Code's settings dropdown.
 */
export function ToggleRailButtons({
  treeVisible,
  propsVisible,
  onToggleTree,
  onToggleProps,
  variant,
  onVariantChange,
}: ToggleRailButtonsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const { settings, setAppWidth, setGradientId } = useAppearance();
  const treeBehaviour = useTreeBehaviour();

  // Local draft for the slider. While the user drags, this is what
  // the popover label and slider show; the global setting (and the
  // resulting frame resize) lags until release. We keep it in sync
  // with the committed value whenever that changes from elsewhere
  // (cross-tab edit, reset to defaults, etc.).
  const [widthDraft, setWidthDraft] = useState<number>(settings.appWidth);
  useEffect(() => {
    setWidthDraft(settings.appWidth);
  }, [settings.appWidth]);

  // Close picker on outside click. Mousedown (not click) so a quick
  // drag on the slider thumb doesn't accidentally close the popover.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    if (pickerOpen) {
      document.addEventListener('mousedown', onDown);
      return () => document.removeEventListener('mousedown', onDown);
    }
  }, [pickerOpen]);

  /** Commit the current draft width to the global appearance store. */
  function commitWidth() {
    if (widthDraft !== settings.appWidth) {
      setAppWidth(widthDraft);
    }
  }

  return (
    <div className="nc-toggles">
      <button
        type="button"
        className={`nc-toggle ${treeVisible ? 'nc-toggle-on' : ''}`}
        onClick={onToggleTree}
        title={treeVisible ? 'Hide folder tree' : 'Show folder tree'}
        aria-pressed={treeVisible}
      >
        📁
      </button>
      <button
        type="button"
        className={`nc-toggle ${propsVisible ? 'nc-toggle-on' : ''}`}
        onClick={onToggleProps}
        title={propsVisible ? 'Hide properties panel' : 'Show properties panel'}
        aria-pressed={propsVisible}
      >
        ℹ️
      </button>
      <div ref={pickerRef} className="nc-variant-picker">
        <button
          type="button"
          className="nc-toggle"
          onClick={() => setPickerOpen((v) => !v)}
          title="Settings"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
        >
          ⚙️
        </button>
        {pickerOpen && (
          <div className="nc-settings-popover" role="menu">
            {/* ----- Tree style ------------------------------------ */}
            <div className="nc-settings-section">
              <div className="nc-variant-heading">Tree style</div>
              {ALL_VARIANTS.map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`nc-variant-option ${
                    v === variant ? 'nc-variant-option-active' : ''
                  }`}
                  onClick={() => onVariantChange(v)}
                  role="menuitemradio"
                  aria-checked={v === variant}
                >
                  {VARIANT_LABELS[v]}
                </button>
              ))}
            </div>

            <div className="nc-settings-divider" />

            {/* ----- Click to expand folders (step 36) ------------- */}
            {/*
              Two-radio choice. "Whole row" (default) means a single
              click anywhere on a folder row toggles its expand AND
              selects/navigates. "Chevron only" reverts to the older
              behaviour where only the small chevron toggles, and the
              row body just selects/navigates. Double-click always
              toggles, in either mode.
            */}
            <div className="nc-settings-section">
              <div className="nc-variant-heading">Click to expand folders</div>
              <button
                type="button"
                className={`nc-variant-option ${
                  treeBehaviour.rowClickExpands ? 'nc-variant-option-active' : ''
                }`}
                onClick={() => treeBehaviour.setRowClickExpands(true)}
                role="menuitemradio"
                aria-checked={treeBehaviour.rowClickExpands}
                title="Click anywhere on a folder row to expand or collapse it"
              >
                Whole row
              </button>
              <button
                type="button"
                className={`nc-variant-option ${
                  !treeBehaviour.rowClickExpands ? 'nc-variant-option-active' : ''
                }`}
                onClick={() => treeBehaviour.setRowClickExpands(false)}
                role="menuitemradio"
                aria-checked={!treeBehaviour.rowClickExpands}
                title="Only the chevron toggles expand. Clicking the row body just selects."
              >
                Chevron only
              </button>
            </div>

            <div className="nc-settings-divider" />

            {/* ----- App width ----------------------------------- */}
            <div className="nc-settings-section">
              <div className="nc-variant-heading">
                App width
                <span className="nc-settings-value">{widthDraft}px</span>
              </div>
              <input
                type="range"
                className="nc-settings-slider"
                min={APP_WIDTH_MIN}
                max={APP_WIDTH_MAX}
                step={APP_WIDTH_STEP}
                value={widthDraft}
                /*
                 * onChange fires on every value tick (mouse drag,
                 * keyboard arrow, touch). We use it ONLY to update
                 * the local draft so the label and thumb track the
                 * cursor. We do NOT commit to global state here —
                 * see the release handlers below.
                 */
                onChange={(e) =>
                  setWidthDraft(parseInt(e.currentTarget.value, 10))
                }
                /*
                 * Commit handlers. Each fires on an end-of-gesture
                 * event:
                 *   - onMouseUp / onTouchEnd / onPointerUp: drag end.
                 *   - onKeyUp: keyboard arrow press released.
                 *   - onBlur: defensive — if the gesture ended in
                 *     some other way (window blur, focus moved),
                 *     we still commit before we lose track.
                 *
                 * Calling setAppWidth with the same value is a no-op
                 * thanks to commitWidth's equality check, so multiple
                 * handlers firing for the same gesture is harmless.
                 */
                onMouseUp={commitWidth}
                onTouchEnd={commitWidth}
                onPointerUp={commitWidth}
                onKeyUp={commitWidth}
                onBlur={commitWidth}
                aria-label="App frame width"
              />
              <div className="nc-settings-range-labels">
                <span>{APP_WIDTH_MIN}px</span>
                <span>{APP_WIDTH_MAX}px</span>
              </div>
            </div>

            <div className="nc-settings-divider" />

            {/* ----- Background gradient -------------------------- */}
            <div className="nc-settings-section">
              <div className="nc-variant-heading">Background</div>
              <div className="nc-settings-gradient-grid">
                {GRADIENT_PRESETS.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={`nc-settings-gradient-swatch ${
                      g.id === settings.gradientId
                        ? 'nc-settings-gradient-swatch-active'
                        : ''
                    }`}
                    onClick={() => setGradientId(g.id)}
                    title={g.label}
                    aria-label={`Background: ${g.label}`}
                    aria-pressed={g.id === settings.gradientId}
                  >
                    {/* Inline style: each swatch shows its own preview.
                        Uses the light value as the visible thumbnail;
                        dark-mode users still get the right colour
                        applied to the body since CSS swaps via
                        prefers-color-scheme. */}
                    <span
                      className="nc-settings-gradient-swatch-fill"
                      style={{ background: g.light }}
                    />
                    <span className="nc-settings-gradient-swatch-label">
                      {g.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
