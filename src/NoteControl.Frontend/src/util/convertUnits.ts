/**
 * Unit definitions for the converter widget.
 *
 * Every category has a BASE unit (its SI unit). Each unit carries a
 * `factor` = how many base units one of this unit equals. Conversion is
 * therefore pure multiplication/division through the base:
 *
 *   base value      = field value × unit.factor
 *   field value     = base value  / unit.factor
 *
 * The widget stores ONE base value per category and renders each field
 * as base / factor, so there's a single source of truth and no
 * cross-unit rounding drift.
 *
 * Factor sources / definitions (exact unless noted):
 *   Force:    N base. lbf = 4.4482216152605 N (exact by definition of
 *             the international pound-force). kgf (kp) = 9.80665 N exact.
 *   Torque:   N·m base. lbf·ft = 1.3558179483314004 N·m,
 *             lbf·in = lbf·ft / 12, kgf·cm = 9.80665 × 0.01 N·m,
 *             oz·in = lbf·in / 16.
 *   Mass:     kg base. lb = 0.45359237 kg exact, oz = lb/16,
 *             g = 1e-3, t (tonne) = 1000.
 *   Inertia:  kg·m² base. g·cm² = 1e-3 kg × 1e-4 m² = 1e-7 kg·m².
 *             kg·cm² = 1e-4 kg·m² (the "kgcm²" Beckhoff uses).
 *             lb·in² = 0.45359237 × 0.0254² kg·m².
 *             oz·in² = lb·in² / 16. slug·ft² = 14.593902937 × 0.3048²
 *             (noted approximate — slug derives from lbf/g).
 *   Length:   m base. in = 0.0254 exact, ft = 0.3048 exact,
 *             mm = 1e-3, cm = 1e-2, km = 1000.
 *   Rotspeed: rad/s base. rpm = 2π/60 rad/s, deg/s = π/180,
 *             Hz (rev/s) = 2π.
 */

export interface UnitDef {
  /** Stable id (used only as a React key). */
  id: string;
  /** Display label, e.g. "lbf·in". */
  label: string;
  /** How many BASE units one of this unit equals. */
  factor: number;
}

export interface UnitCategory {
  id: string;
  label: string;
  /** SI base unit label, for the header note. */
  baseLabel: string;
  units: UnitDef[];
}

export const UNIT_CATEGORIES: UnitCategory[] = [
  {
    id: 'force',
    label: 'Force',
    baseLabel: 'N',
    units: [
      { id: 'N', label: 'N', factor: 1 },
      { id: 'kN', label: 'kN', factor: 1000 },
      { id: 'mN', label: 'mN', factor: 1e-3 },
      { id: 'kgf', label: 'kgf (kp)', factor: 9.80665 },
      { id: 'lbf', label: 'lbf', factor: 4.4482216152605 },
      { id: 'ozf', label: 'ozf', factor: 4.4482216152605 / 16 },
    ],
  },
  {
    id: 'torque',
    label: 'Torque',
    baseLabel: 'N·m',
    units: [
      { id: 'Nm', label: 'N·m', factor: 1 },
      { id: 'Ncm', label: 'N·cm', factor: 0.01 },
      { id: 'mNm', label: 'mN·m', factor: 1e-3 },
      { id: 'kgfcm', label: 'kgf·cm', factor: 9.80665 * 0.01 },
      { id: 'kgfm', label: 'kgf·m', factor: 9.80665 },
      { id: 'lbfft', label: 'lbf·ft', factor: 1.3558179483314004 },
      { id: 'lbfin', label: 'lbf·in', factor: 1.3558179483314004 / 12 },
      { id: 'ozin', label: 'oz·in', factor: 1.3558179483314004 / 12 / 16 },
    ],
  },
  {
    id: 'mass',
    label: 'Mass',
    baseLabel: 'kg',
    units: [
      { id: 'kg', label: 'kg', factor: 1 },
      { id: 'g', label: 'g', factor: 1e-3 },
      { id: 't', label: 't (tonne)', factor: 1000 },
      { id: 'lb', label: 'lb', factor: 0.45359237 },
      { id: 'oz', label: 'oz', factor: 0.45359237 / 16 },
    ],
  },
  {
    id: 'inertia',
    label: 'Inertia',
    baseLabel: 'kg·m²',
    units: [
      { id: 'kgm2', label: 'kg·m²', factor: 1 },
      { id: 'kgcm2', label: 'kg·cm²', factor: 1e-4 },
      { id: 'gcm2', label: 'g·cm²', factor: 1e-7 },
      { id: 'lbin2', label: 'lb·in²', factor: 0.45359237 * 0.0254 * 0.0254 },
      {
        id: 'ozin2',
        label: 'oz·in²',
        factor: (0.45359237 * 0.0254 * 0.0254) / 16,
      },
      {
        id: 'slugft2',
        label: 'slug·ft²',
        factor: 14.593902937 * 0.3048 * 0.3048,
      },
    ],
  },
  {
    id: 'length',
    label: 'Length',
    baseLabel: 'm',
    units: [
      { id: 'm', label: 'm', factor: 1 },
      { id: 'mm', label: 'mm', factor: 1e-3 },
      { id: 'cm', label: 'cm', factor: 1e-2 },
      { id: 'km', label: 'km', factor: 1000 },
      { id: 'in', label: 'in', factor: 0.0254 },
      { id: 'ft', label: 'ft', factor: 0.3048 },
    ],
  },
  {
    id: 'rotspeed',
    label: 'Rotational speed',
    baseLabel: 'rad/s',
    units: [
      { id: 'rads', label: 'rad/s', factor: 1 },
      { id: 'rpm', label: 'rpm (rev/min)', factor: (2 * Math.PI) / 60 },
      { id: 'degs', label: 'deg/s', factor: Math.PI / 180 },
      { id: 'revs', label: 'rev/s (Hz)', factor: 2 * Math.PI },
    ],
  },
];

/** Look up a category by id, falling back to the first one. */
export function categoryById(id: string): UnitCategory {
  return UNIT_CATEGORIES.find((c) => c.id === id) ?? UNIT_CATEGORIES[0];
}

/**
 * Format a base value as a field value for a given unit, with a sensible
 * number of significant digits and no trailing-zero noise. Returns an
 * empty string for a zero/blank base so empty fields stay empty.
 */
export function formatField(baseValue: number, unit: UnitDef): string {
  if (!Number.isFinite(baseValue) || baseValue === 0) return '';
  const v = baseValue / unit.factor;
  if (!Number.isFinite(v)) return '';
  // Up to 8 significant digits; strip trailing zeros via Number round-trip.
  const s = v.toPrecision(8);
  return String(Number(s));
}
