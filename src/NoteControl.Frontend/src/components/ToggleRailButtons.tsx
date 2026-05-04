import { useEffect, useRef, useState } from 'react';

import {
  ALL_VARIANTS,
  VARIANT_LABELS,
  type TreeVariant,
} from '../tree/treeStyles';
import {
  FONT_OPTIONS,
  TREE_FONT_SIZE_MAX,
  TREE_FONT_SIZE_MIN,
  type TreeAppearance,
} from '../tree/treeAppearance';
import { fontStackToId } from './EditableNoteAppearance';
import {
  APP_WIDTH_MAX,
  APP_WIDTH_MIN,
  APP_WIDTH_STEP,
  GRADIENT_PRESETS,
  useAppearance,
} from '../settings/appearance';
import {
  NOTE_FONT_SIZE_MAX,
  NOTE_FONT_SIZE_MIN,
  NOTE_WIDTH_MAX,
  NOTE_WIDTH_MIN,
  useNoteDefaults,
} from '../settings/noteDefaults';
import { useTreeBehaviour } from '../settings/treeBehaviour';

export interface ToggleRailButtonsProps {
  treeVisible: boolean;
  propsVisible: boolean;
  onToggleTree: () => void;
  onToggleProps: () => void;
  variant: TreeVariant;
  onVariantChange: (v: TreeVariant) => void;
  /**
   * Ship 53: tree font + font-size controls. Owned by VaultLayout
   * via useTreeAppearance(); we just read + dispatch.
   */
  treeAppearance: TreeAppearance;
  /**
   * Ship 70: which subset of buttons this instance renders.
   *   - "toggles" → 📁 ℹ️ pair only (default; lives next to search)
   *   - "settings" → ⚙️ button + popover (lives at the right edge,
   *      next to the account menu, after Ship 70)
   *
   * Both slots accept the same props because the cog popover wants
   * variant + treeAppearance, and the toggle pair conceptually
   * belongs to the same "view controls" group. Splitting the props
   * into two interfaces would just mean passing the same data
   * twice from VaultLayout. Default is "toggles" for backwards
   * compatibility with any caller that doesn't pass slot.
   */
  slot?: 'toggles' | 'settings';
}

/**
 * View-control buttons that live in the TopBar:
 *   - slot="toggles":  📁 toggle tree rail, ℹ️ toggle properties rail
 *   - slot="settings": ⚙️ open settings popover
 *
 * The settings popover hosts:
 *   - tree style picker (compact / comfortable)
 *   - tree font + font size (Ship 53)
 *   - note defaults: width / font / font size (Ship 54)
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
  treeAppearance,
  slot = 'toggles',
}: ToggleRailButtonsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const { settings, setAppWidth, setGradientId } = useAppearance();
  const treeBehaviour = useTreeBehaviour();
  const noteDefaults = useNoteDefaults();

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

  // Resolve the current font's id (for the <select>'s value) from
  // its stack. Same helper notes-side appearance uses, so the
  // dropdown shows "Default" for any unrecognised stack.
  const currentTreeFontId = fontStackToId(treeAppearance.fontStack);
  const currentNoteFontId = fontStackToId(noteDefaults.defaults.fontStack);

  // Local drafts for number inputs. We commit on blur / Enter so
  // the user can type "1" → "12" → "16" without each digit being
  // saved as an intermediate value.
  const [treeSizeDraft, setTreeSizeDraft] = useState<string>(
    treeAppearance.fontSize === null ? '' : String(treeAppearance.fontSize),
  );
  useEffect(() => {
    setTreeSizeDraft(
      treeAppearance.fontSize === null ? '' : String(treeAppearance.fontSize),
    );
  }, [treeAppearance.fontSize]);

  const [noteWidthDraft, setNoteWidthDraft] = useState<string>(
    String(noteDefaults.defaults.width),
  );
  useEffect(() => {
    setNoteWidthDraft(String(noteDefaults.defaults.width));
  }, [noteDefaults.defaults.width]);

  const [noteSizeDraft, setNoteSizeDraft] = useState<string>(
    String(noteDefaults.defaults.fontSize),
  );
  useEffect(() => {
    setNoteSizeDraft(String(noteDefaults.defaults.fontSize));
  }, [noteDefaults.defaults.fontSize]);

  function commitTreeSize() {
    const trimmed = treeSizeDraft.trim();
    if (trimmed === '') {
      treeAppearance.setFontSize(null);
      return;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) {
      // Reset draft to the persisted value rather than leave it stuck
      // on garbage text.
      setTreeSizeDraft(
        treeAppearance.fontSize === null ? '' : String(treeAppearance.fontSize),
      );
      return;
    }
    const clamped = Math.max(TREE_FONT_SIZE_MIN, Math.min(TREE_FONT_SIZE_MAX, n));
    treeAppearance.setFontSize(clamped);
    if (clamped !== n) {
      setTreeSizeDraft(String(clamped));
    }
  }

  // Note defaults can never be "null / blank" the way the tree's
  // font size can — they always have a numeric value because they
  // ARE the default. Empty input on commit resets to the canonical
  // default rather than to "no value".
  function commitNoteWidth() {
    const trimmed = noteWidthDraft.trim();
    if (trimmed === '') {
      // Reset to canonical default (1000).
      noteDefaults.setWidth(noteDefaults.defaults.width); // unchanged
      setNoteWidthDraft(String(noteDefaults.defaults.width));
      return;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) {
      setNoteWidthDraft(String(noteDefaults.defaults.width));
      return;
    }
    const clamped = Math.max(NOTE_WIDTH_MIN, Math.min(NOTE_WIDTH_MAX, n));
    noteDefaults.setWidth(clamped);
    if (clamped !== n) {
      setNoteWidthDraft(String(clamped));
    }
  }

  function commitNoteSize() {
    const trimmed = noteSizeDraft.trim();
    if (trimmed === '') {
      setNoteSizeDraft(String(noteDefaults.defaults.fontSize));
      return;
    }
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) {
      setNoteSizeDraft(String(noteDefaults.defaults.fontSize));
      return;
    }
    const clamped = Math.max(NOTE_FONT_SIZE_MIN, Math.min(NOTE_FONT_SIZE_MAX, n));
    noteDefaults.setFontSize(clamped);
    if (clamped !== n) {
      setNoteSizeDraft(String(clamped));
    }
  }

  // Ship 70: render only the slice the caller asked for. Both
  // slots share the state above (cheap; the only state that
  // matters for "settings" is unused when slot="toggles" but
  // doesn't hurt). Keeping the component unified means the
  // popover content stays in one place — splitting it across
  // two files would mean migrating ~300 lines of useState +
  // commit handlers along with it.
  if (slot === 'settings') {
    return (
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

            {/* ----- Tree font (Ship 53) ----------------------------
              Uses the same FONT_OPTIONS list as per-note appearance,
              so the dropdown stays in sync if we add/remove fonts
              there. The "Default" entry sends an empty stack which
              clears the inline style and lets the tree fall back to
              the app body font.
            */}
            <div className="nc-settings-section">
              <div className="nc-variant-heading">Tree font</div>
              <select
                className="nc-settings-select"
                value={currentTreeFontId}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  const opt = FONT_OPTIONS.find((f) => f.id === id);
                  treeAppearance.setFontStack(opt?.stack ?? '');
                }}
                aria-label="Tree font"
              >
                {FONT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="nc-settings-section">
              <div className="nc-variant-heading">
                Tree font size
                <span className="nc-settings-value">
                  {treeAppearance.fontSize === null
                    ? 'Default'
                    : `${treeAppearance.fontSize}px`}
                </span>
              </div>
              <input
                type="number"
                className="nc-settings-number"
                min={TREE_FONT_SIZE_MIN}
                max={TREE_FONT_SIZE_MAX}
                step={1}
                value={treeSizeDraft}
                placeholder="Default"
                onChange={(e) => setTreeSizeDraft(e.currentTarget.value)}
                onBlur={commitTreeSize}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTreeSize();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Tree font size in pixels"
              />
              <div className="nc-settings-range-labels">
                <span>{TREE_FONT_SIZE_MIN}px</span>
                <span>{TREE_FONT_SIZE_MAX}px</span>
              </div>
            </div>

            <div className="nc-settings-divider" />

            {/* ----- Note defaults (Ship 54) ------------------------
              Resolution order at render time is:
                  per-note frontmatter → global default → CSS baseline
              So setting a value here only affects notes that don't
              have an explicit per-note value set. Existing notes
              with explicit Width/Font/FontSize keep their per-note
              behaviour exactly.
            */}
            <div className="nc-settings-section">
              <div className="nc-variant-heading">
                Note width
                <span className="nc-settings-value">
                  {noteDefaults.defaults.width}px
                </span>
              </div>
              <input
                type="number"
                className="nc-settings-number"
                min={NOTE_WIDTH_MIN}
                max={NOTE_WIDTH_MAX}
                step={50}
                value={noteWidthDraft}
                onChange={(e) => setNoteWidthDraft(e.currentTarget.value)}
                onBlur={commitNoteWidth}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitNoteWidth();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Default note width in pixels"
              />
              <div className="nc-settings-range-labels">
                <span>{NOTE_WIDTH_MIN}px</span>
                <span>{NOTE_WIDTH_MAX}px</span>
              </div>
            </div>

            <div className="nc-settings-section">
              <div className="nc-variant-heading">Note font</div>
              <select
                className="nc-settings-select"
                value={currentNoteFontId}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  const opt = FONT_OPTIONS.find((f) => f.id === id);
                  noteDefaults.setFontStack(opt?.stack ?? '');
                }}
                aria-label="Default note font"
              >
                {FONT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="nc-settings-section">
              <div className="nc-variant-heading">
                Note font size
                <span className="nc-settings-value">
                  {noteDefaults.defaults.fontSize}px
                </span>
              </div>
              <input
                type="number"
                className="nc-settings-number"
                min={NOTE_FONT_SIZE_MIN}
                max={NOTE_FONT_SIZE_MAX}
                step={1}
                value={noteSizeDraft}
                onChange={(e) => setNoteSizeDraft(e.currentTarget.value)}
                onBlur={commitNoteSize}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitNoteSize();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Default note font size in pixels"
              />
              <div className="nc-settings-range-labels">
                <span>{NOTE_FONT_SIZE_MIN}px</span>
                <span>{NOTE_FONT_SIZE_MAX}px</span>
              </div>
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
    );
  }

  // Default slot: 📁 + ℹ️ pair. Sits next to the search box in
  // the topbar, separate from the settings cog (which now lives
  // next to the account menu on the right edge).
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
    </div>
  );
}
