import { useCallback, useMemo, useState } from 'react';

import type { ConvertBlockDto } from '../api/types';
import {
  UNIT_CATEGORIES,
  categoryById,
  formatField,
  type UnitDef,
} from '../util/convertUnits';

/**
 * Live unit-converter widget.
 *
 * Pick a category (Force, Torque, Mass, Inertia, Length, Rotational
 * speed); every unit in that category gets an input. Type in any field
 * and the rest update instantly. Metric + imperial + servo-typical
 * units (kg·cm², oz·in, …).
 *
 * Model: the payload stores ONE base-SI value per category
 * (block.values[categoryId]). Each field shows base / unit.factor;
 * editing a field sets base = typed × unit.factor. This keeps a single
 * source of truth — no per-unit text, no cross-unit rounding drift.
 *
 * Typing UX: the field being actively edited is held verbatim in local
 * state (`editing`) so partial input like "1." or "0.000" isn't
 * reformatted out from under the cursor. All OTHER fields render from
 * the committed base value. On blur the local override is dropped and
 * the field falls back to the formatted base value.
 *
 * Hosted by NoteWidgetStack like the other note widgets:
 * { block, onChange(patch), onDelete }.
 */

export interface ConvertBlockProps {
  block: ConvertBlockDto;
  onChange: (patch: Partial<ConvertBlockDto>) => void;
  onDelete: () => void;
}

export function ConvertBlock({ block, onChange, onDelete }: ConvertBlockProps) {
  const category = useMemo(() => categoryById(block.category), [block.category]);

  // The committed base-SI value for the active category (0 if unset).
  const baseValue = block.values?.[category.id] ?? 0;

  // While a field is being typed we keep its raw text here so we don't
  // reformat mid-entry. { unitId, text } or null when nothing is being
  // edited. Cleared on blur and on category change.
  const [editing, setEditing] = useState<{ unitId: string; text: string } | null>(
    null,
  );

  const setBase = useCallback(
    (next: number) => {
      const values = { ...(block.values ?? {}), [category.id]: next };
      onChange({ values });
    },
    [block.values, category.id, onChange],
  );

  const onSelectCategory = useCallback(
    (id: string) => {
      setEditing(null);
      onChange({ category: id });
    },
    [onChange],
  );

  const onFieldChange = useCallback(
    (unit: UnitDef, text: string) => {
      // Hold the raw text so the field shows exactly what's typed.
      setEditing({ unitId: unit.id, text });
      // Parse and commit the base value. Treat blank / lone sign / lone
      // dot as "no change to a meaningful number" → base 0 only when
      // truly empty, otherwise ignore un-parseable partials.
      const trimmed = text.trim();
      if (trimmed === '') {
        setBase(0);
        return;
      }
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        setBase(n * unit.factor);
      }
      // If not finite (e.g. "1." mid-type, "-", "1e"), leave the base
      // as-is; the next valid keystroke commits.
    },
    [setBase],
  );

  const onFieldBlur = useCallback(() => setEditing(null), []);

  const clearAll = useCallback(() => {
    setEditing(null);
    setBase(0);
  }, [setBase]);

  return (
    <div className="nc-convert-block">
      <div className="nc-convert-block-header">
        <span className="nc-convert-block-title">Unit converter</span>
        <span className="nc-convert-block-actions">
          <select
            className="nc-convert-category"
            value={category.id}
            onChange={(e) => onSelectCategory(e.target.value)}
            aria-label="Category"
            title="Conversion category"
          >
            {UNIT_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="nc-convert-block-iconbtn"
            onClick={clearAll}
            title="Clear values"
            aria-label="Clear values"
          >
            ⌫
          </button>
          <button
            type="button"
            className="nc-convert-block-iconbtn"
            onClick={onDelete}
            title="Delete widget"
            aria-label="Delete widget"
          >
            ✕
          </button>
        </span>
      </div>

      <div className="nc-convert-block-body">
        <div className="nc-convert-grid">
          {category.units.map((unit) => {
            const isEditing = editing?.unitId === unit.id;
            const value = isEditing ? editing!.text : formatField(baseValue, unit);
            return (
              <label key={unit.id} className="nc-convert-row">
                <span className="nc-convert-unit">{unit.label}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="nc-convert-input"
                  value={value}
                  placeholder="0"
                  onChange={(e) => onFieldChange(unit, e.target.value)}
                  onBlur={onFieldBlur}
                  onFocus={(e) => e.target.select()}
                  spellCheck={false}
                />
              </label>
            );
          })}
        </div>
        <div className="nc-convert-foot">
          Base unit: <strong>{category.baseLabel}</strong>
        </div>
      </div>
    </div>
  );
}
