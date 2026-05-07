import { useState } from 'react';

import type {
  Environment, RuntimeValue, ScalarValue, FbInstance, UnknownInstance,
} from '../runtime/interpreter';
import {
  formatRuntimeValue, pokeVariable, pokeMember,
} from '../runtime/interpreter';
import type { ParsedProgram, ScalarTypeName, VarSection } from '../runtime/ast';
import { PillEditor, formatTimeForPill } from './InlineSource';

/**
 * Watch table rendered in the Declaration pane when the user
 * toggles to "Watch" mode.
 *
 * Visual model (TwinCAT online view, condensed):
 *   - One row per declared variable, in source order.
 *   - Columns: Name | Type | Value | Section.
 *   - Section is a small colored tag (INPUT / OUTPUT / IN_OUT /
 *     LOCAL / TEMP / ...). Color matches TwinCAT's online-view
 *     scheme loosely: inputs lean cool, outputs lean warm.
 *   - FB instances (built-in TON/TOF/R_TRIG/F_TRIG and unknown
 *     user-defined ones) get a leading chevron. Click to expand
 *     into indented member rows. Members of built-in FBs are
 *     read-only (the FB schema computes them); members of
 *     unknown FBs are pokeable with type-inferred input, same
 *     as in the Implementation pane.
 *   - Value cells are pokeable with the same rules as the
 *     Implementation pane: single-click opens an inline editor;
 *     double-click toggles BOOLs; FB-known-members are
 *     read-only; unknowns infer type from input syntax.
 *
 * The component re-renders on every `envVersion` bump from the
 * parent so live values track the scan loop.
 */
export interface WatchTableProps {
  program: ParsedProgram;
  env: Environment;
  /** Bump-counter from the modal — same prop semantics as
   *  InlineSource. Used only to force re-renders; not read. */
  envVersion: number;
  /** True when poking is allowed (modal not in error mode). */
  pokeEnabled: boolean;
}

/** Identity of the row being edited. For top-level scalars and
 *  unknown bare vars, `memberLower` is null. For FB-instance
 *  member edits (only valid on unknown FBs), it's the lowercased
 *  member name. */
interface EditingTarget {
  nameLower: string;
  memberLower: string | null;
}

/** Per-row metadata derived for a single render pass. Keeps the
 *  table-cell renderer thin. */
interface RowDerivation {
  /** Display name. For member rows, the parent's name is in the
   *  parent row above; this is just the member name. */
  displayName: string;
  /** "BOOL", "TON", "FB_Custom (unknown)", etc. */
  typeLabel: string;
  /** Pre-formatted value text (or "?" for missing-unknown). */
  formattedValue: string;
  /** ScalarType when known, null when not (FB instances bare;
   *  unknowns with no value yet). Drives BOOL pill styling and
   *  double-click toggle eligibility. */
  pillType: ScalarTypeName | null;
  /** True for BOOL pills currently TRUE. */
  isBoolTrue: boolean;
  /** True when we have nothing to show yet (FB bare ref or
   *  un-poked unknown). Renders muted. */
  isMissing: boolean;
  /** True when underlying var is unknown-typed; greys the row. */
  isUnknownTyped: boolean;
  /** What kind of poke to do when the user commits the editor.
   *  null when the row isn't pokeable (FB-instance bare row,
   *  known-FB member). */
  pokeKind: 'scalar' | 'unknown-var' | 'unknown-member' | null;
}

export function WatchTable({
  program, env, envVersion, pokeEnabled,
}: WatchTableProps) {
  void envVersion; // re-render trigger only

  // Which FB-instance rows are expanded. Keyed by lowercased
  // variable name. Default: collapsed. Persisted only across
  // re-renders; reset when the modal re-mounts (acceptable —
  // a sandbox session is short).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [, forceRender] = useState({});

  function toggleExpand(nameLower: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(nameLower)) next.delete(nameLower);
      else next.add(nameLower);
      return next;
    });
  }

  // Build the visible row list. Top-level vars in source order,
  // with member rows interleaved beneath any expanded FB instance.
  type Row =
    | { kind: 'top'; varIdx: number }
    | { kind: 'member-known'; varIdx: number; memberLower: string; memberName: string }
    | { kind: 'member-unknown'; varIdx: number; memberLower: string };
  const rows: Row[] = [];
  for (let i = 0; i < program.program.vars.length; i++) {
    const v = program.program.vars[i];
    rows.push({ kind: 'top', varIdx: i });
    const stored = env.get(v.nameLower);
    if (!stored || !expanded.has(v.nameLower)) continue;
    if (stored.kind === 'fb') {
      // Known FB: show the schema-known members. We hardcode the
      // member list here per FB type because the schema map is
      // private to the interpreter; revisit if/when more FB types
      // land.
      const members = knownFbMembers(stored);
      for (const m of members) {
        rows.push({
          kind: 'member-known',
          varIdx: i,
          memberLower: m.lower,
          memberName: m.name,
        });
      }
    } else if (stored.kind === 'unknown') {
      // Unknown FB / DUT: show whatever's been poked. Sorted by
      // member name so the order is stable across pokes.
      const memberKeys = Array.from(stored.members.keys()).sort();
      for (const k of memberKeys) {
        rows.push({ kind: 'member-unknown', varIdx: i, memberLower: k });
      }
      // If the user hasn't poked any members yet, show one
      // hint row so they know expansion did something. Using
      // a synthetic memberLower of empty string, handled in
      // renderRow below.
      if (memberKeys.length === 0) {
        rows.push({ kind: 'member-unknown', varIdx: i, memberLower: '' });
      }
    }
  }

  return (
    <div className="nc-runtime-watch-wrap">
      <table className="nc-runtime-watch-table">
        <thead>
          <tr>
            <th className="nc-runtime-watch-col-name">Name</th>
            <th className="nc-runtime-watch-col-type">Type</th>
            <th className="nc-runtime-watch-col-value">Value</th>
            <th className="nc-runtime-watch-col-section">Section</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => renderRow(
            r, idx, program, env, pokeEnabled,
            expanded, toggleExpand,
            editing, setEditing,
            () => forceRender({}),
          ))}
        </tbody>
      </table>
    </div>
  );
}

function knownFbMembers(inst: FbInstance): { lower: string; name: string }[] {
  // Hardcoded per FB type. Matches the schema in interpreter.ts.
  switch (inst.fbType) {
    case 'TON':
    case 'TOF':
      return [{ lower: 'q', name: 'Q' }, { lower: 'et', name: 'ET' }];
    case 'R_TRIG':
    case 'F_TRIG':
      return [{ lower: 'q', name: 'Q' }];
  }
}

function renderRow(
  row:
    | { kind: 'top'; varIdx: number }
    | { kind: 'member-known'; varIdx: number; memberLower: string; memberName: string }
    | { kind: 'member-unknown'; varIdx: number; memberLower: string },
  rowKey: number,
  program: ParsedProgram,
  env: Environment,
  pokeEnabled: boolean,
  expanded: Set<string>,
  toggleExpand: (k: string) => void,
  editing: EditingTarget | null,
  setEditing: (v: EditingTarget | null) => void,
  forceRender: () => void,
) {
  const v = program.program.vars[row.varIdx];
  const stored = env.get(v.nameLower);

  if (row.kind === 'top') {
    return (
      <TopRow
        key={`top-${rowKey}`}
        varName={v.name}
        section={v.section}
        stored={stored}
        typeRefDisplay={typeRefDisplay(v.type, stored)}
        nameLower={v.nameLower}
        expandable={isExpandable(stored)}
        isExpanded={expanded.has(v.nameLower)}
        onToggleExpand={() => toggleExpand(v.nameLower)}
        pokeEnabled={pokeEnabled}
        editing={editing}
        setEditing={setEditing}
        env={env}
        forceRender={forceRender}
      />
    );
  }

  // Member row. Indent under the parent.
  if (row.kind === 'member-known') {
    if (!stored || stored.kind !== 'fb') return null;
    return (
      <KnownMemberRow
        key={`mk-${rowKey}`}
        parentVarName={v.name}
        memberName={row.memberName}
        memberLower={row.memberLower}
        instance={stored}
      />
    );
  }
  // member-unknown
  if (!stored || stored.kind !== 'unknown') return null;
  return (
    <UnknownMemberRow
      key={`mu-${rowKey}`}
      parentVarName={v.name}
      parentNameLower={v.nameLower}
      parentTypeName={stored.typeName}
      memberLower={row.memberLower}
      instance={stored}
      pokeEnabled={pokeEnabled}
      editing={editing}
      setEditing={setEditing}
      env={env}
      forceRender={forceRender}
    />
  );
}

function isExpandable(stored: RuntimeValue | undefined): boolean {
  if (!stored) return false;
  return stored.kind === 'fb' || stored.kind === 'unknown';
}

function typeRefDisplay(type: { kind: string; name?: string; unknownName?: string }, stored: RuntimeValue | undefined): string {
  if (type.kind === 'unknown') {
    return `${type.unknownName} (unknown)`;
  }
  if (type.kind === 'fb') return type.name as string;
  // Scalar — fall back to stored.type if available (covers the
  // unusual case where someone poked a different type into an
  // unknown bare var; not relevant here since this is the
  // declared type, but stored is paranoid backup).
  void stored;
  return type.name as string;
}

// ---- Top-level row -----------------------------------------------

function TopRow({
  varName, section, stored, typeRefDisplay,
  nameLower, expandable, isExpanded, onToggleExpand,
  pokeEnabled, editing, setEditing, env, forceRender,
}: {
  varName: string;
  section: VarSection;
  stored: RuntimeValue | undefined;
  typeRefDisplay: string;
  nameLower: string;
  expandable: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  pokeEnabled: boolean;
  editing: EditingTarget | null;
  setEditing: (v: EditingTarget | null) => void;
  env: Environment;
  forceRender: () => void;
}) {
  const data = deriveTopRowData(varName, stored, typeRefDisplay);
  const isUnknown = stored?.kind === 'unknown';
  const isEditing =
    editing !== null && data.pokeKind !== null &&
    editing.nameLower === nameLower &&
    editing.memberLower === null;
  return (
    <tr className={isUnknown ? 'nc-runtime-watch-row-unknown' : undefined}>
      <td className="nc-runtime-watch-col-name">
        {expandable && (
          <button
            type="button"
            className={
              'nc-runtime-watch-chevron' +
              (isExpanded ? ' nc-runtime-watch-chevron-open' : '')
            }
            onClick={onToggleExpand}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            ▶
          </button>
        )}
        {!expandable && <span className="nc-runtime-watch-chevron-spacer" />}
        <span className={isUnknown ? 'nc-runtime-ident-unknown' : undefined}>
          {varName}
        </span>
      </td>
      <td className="nc-runtime-watch-col-type">{data.typeLabel}</td>
      <td className="nc-runtime-watch-col-value">
        <ValueCell
          data={data}
          nameLower={nameLower}
          memberLower={null}
          isEditing={isEditing}
          pokeEnabled={pokeEnabled}
          setEditing={setEditing}
          env={env}
          forceRender={forceRender}
        />
      </td>
      <td className="nc-runtime-watch-col-section">
        <SectionTag section={section} />
      </td>
    </tr>
  );
}

function deriveTopRowData(
  _varName: string,
  stored: RuntimeValue | undefined,
  typeRefDisplay: string,
): RowDerivation {
  if (!stored) {
    return {
      displayName: _varName, typeLabel: typeRefDisplay,
      formattedValue: '?', pillType: null,
      isBoolTrue: false, isMissing: true,
      isUnknownTyped: false, pokeKind: null,
    };
  }
  if (stored.kind === 'fb') {
    return {
      displayName: _varName, typeLabel: typeRefDisplay,
      formattedValue: `<${stored.fbType}>`,
      pillType: null, isBoolTrue: false,
      isMissing: false, isUnknownTyped: false,
      pokeKind: null,
    };
  }
  if (stored.kind === 'unknown') {
    if (stored.scalarValue === null) {
      return {
        displayName: _varName, typeLabel: typeRefDisplay,
        formattedValue: `<${stored.typeName}?>`,
        pillType: null, isBoolTrue: false,
        isMissing: true, isUnknownTyped: true,
        pokeKind: 'unknown-var',
      };
    }
    const sv = stored.scalarValue;
    return {
      displayName: _varName, typeLabel: typeRefDisplay,
      formattedValue: formatRuntimeValue(sv),
      pillType: sv.type,
      isBoolTrue: sv.type === 'BOOL' && sv.value === true,
      isMissing: false, isUnknownTyped: true,
      pokeKind: 'unknown-var',
    };
  }
  // Known scalar.
  return {
    displayName: _varName, typeLabel: typeRefDisplay,
    formattedValue: formatRuntimeValue(stored),
    pillType: stored.type,
    isBoolTrue: stored.type === 'BOOL' && stored.value === true,
    isMissing: false, isUnknownTyped: false,
    pokeKind: 'scalar',
  };
}

// ---- Member rows -------------------------------------------------

function KnownMemberRow({
  parentVarName, memberName, memberLower, instance,
}: {
  parentVarName: string;
  memberName: string;
  memberLower: string;
  instance: FbInstance;
}) {
  // Read the member from FB state. Mirrors the inline pill logic
  // in InlineSource but rendered as a table row.
  const ms = instance.state;
  let formattedValue = '?';
  let pillType: ScalarTypeName | null = null;
  let isBoolTrue = false;
  if (memberLower === 'q') {
    const q = ms.q === true;
    formattedValue = q ? 'TRUE' : 'FALSE';
    pillType = 'BOOL';
    isBoolTrue = q;
  } else if (memberLower === 'et') {
    const et = (ms.et ?? 0) as number;
    formattedValue = formatTimeForPill(et);
    pillType = 'TIME';
  }

  let valueCls = 'nc-runtime-watch-value';
  if (pillType === 'BOOL') {
    valueCls += isBoolTrue
      ? ' nc-runtime-pill-bool nc-runtime-pill-bool-true'
      : ' nc-runtime-pill-bool nc-runtime-pill-bool-false';
  } else {
    valueCls += ' nc-runtime-pill';
  }

  return (
    <tr className="nc-runtime-watch-row-child">
      <td className="nc-runtime-watch-col-name">
        <span className="nc-runtime-watch-indent" />
        <span className="nc-runtime-watch-member-dot">.</span>
        {memberName}
        <span
          className="nc-runtime-watch-parent-hint"
          title={`Member of ${parentVarName} (read-only — derived each scan)`}
        >
          ↑
        </span>
      </td>
      <td className="nc-runtime-watch-col-type">{pillType ?? '?'}</td>
      <td className="nc-runtime-watch-col-value">
        <span
          className={valueCls}
          title="Read-only — computed each scan from the FB's tick"
        >
          {formattedValue}
        </span>
      </td>
      <td className="nc-runtime-watch-col-section">
        <span className="nc-runtime-watch-section nc-runtime-watch-section-member">
          member
        </span>
      </td>
    </tr>
  );
}

function UnknownMemberRow({
  parentVarName, parentNameLower, parentTypeName,
  memberLower, instance,
  pokeEnabled, editing, setEditing, env, forceRender,
}: {
  parentVarName: string;
  parentNameLower: string;
  parentTypeName: string;
  memberLower: string;
  instance: UnknownInstance;
  pokeEnabled: boolean;
  editing: EditingTarget | null;
  setEditing: (v: EditingTarget | null) => void;
  env: Environment;
  forceRender: () => void;
}) {
  // Empty-state row (the "no members poked yet" hint).
  if (memberLower === '') {
    return (
      <tr className="nc-runtime-watch-row-child nc-runtime-watch-row-hint">
        <td className="nc-runtime-watch-col-name">
          <span className="nc-runtime-watch-indent" />
          <span className="nc-runtime-watch-empty-hint">
            no members poked yet
          </span>
        </td>
        <td className="nc-runtime-watch-col-type" />
        <td className="nc-runtime-watch-col-value nc-runtime-watch-empty-hint">
          poke {parentVarName}.SomeName from the body, or it appears here once referenced
        </td>
        <td className="nc-runtime-watch-col-section">
          <span className="nc-runtime-watch-section nc-runtime-watch-section-member">
            member
          </span>
        </td>
      </tr>
    );
  }

  const poked = instance.members.get(memberLower);
  let data: RowDerivation;
  if (!poked) {
    data = {
      displayName: memberLower, typeLabel: '(unknown)',
      formattedValue: '?', pillType: null,
      isBoolTrue: false, isMissing: true,
      isUnknownTyped: true, pokeKind: 'unknown-member',
    };
  } else {
    data = {
      displayName: memberLower, typeLabel: poked.type,
      formattedValue: formatRuntimeValue(poked),
      pillType: poked.type,
      isBoolTrue: poked.type === 'BOOL' && poked.value === true,
      isMissing: false, isUnknownTyped: true,
      pokeKind: 'unknown-member',
    };
  }
  const isEditing =
    editing !== null && data.pokeKind !== null &&
    editing.nameLower === parentNameLower &&
    editing.memberLower === memberLower;
  return (
    <tr className="nc-runtime-watch-row-child nc-runtime-watch-row-unknown">
      <td className="nc-runtime-watch-col-name">
        <span className="nc-runtime-watch-indent" />
        <span className="nc-runtime-watch-member-dot">.</span>
        <span className="nc-runtime-ident-unknown">{memberLower}</span>
        <span
          className="nc-runtime-watch-parent-hint"
          title={`Member of ${parentVarName} (${parentTypeName}, unknown)`}
        >
          ↑
        </span>
      </td>
      <td className="nc-runtime-watch-col-type">{data.typeLabel}</td>
      <td className="nc-runtime-watch-col-value">
        <ValueCell
          data={data}
          nameLower={parentNameLower}
          memberLower={memberLower}
          isEditing={isEditing}
          pokeEnabled={pokeEnabled}
          setEditing={setEditing}
          env={env}
          forceRender={forceRender}
        />
      </td>
      <td className="nc-runtime-watch-col-section">
        <span className="nc-runtime-watch-section nc-runtime-watch-section-member">
          member
        </span>
      </td>
    </tr>
  );
}

// ---- Value cell (pill rendering, click handlers, edit) ----------

function ValueCell({
  data, nameLower, memberLower,
  isEditing, pokeEnabled,
  setEditing, env, forceRender,
}: {
  data: RowDerivation;
  nameLower: string;
  memberLower: string | null;
  isEditing: boolean;
  pokeEnabled: boolean;
  setEditing: (v: EditingTarget | null) => void;
  env: Environment;
  forceRender: () => void;
}) {
  if (isEditing && data.pokeKind !== null) {
    return (
      <PillEditor
        nameLower={nameLower}
        memberLower={memberLower}
        pokeKind={data.pokeKind}
        currentText={data.formattedValue.replace(/^'|'$/g, '')}
        env={env}
        onCommit={(success) => {
          setEditing(null);
          if (success) forceRender();
        }}
      />
    );
  }

  let cls = 'nc-runtime-pill';
  if (data.isMissing) cls += ' nc-runtime-pill-missing';
  else if (data.pillType === 'BOOL') {
    cls += data.isBoolTrue
      ? ' nc-runtime-pill-bool nc-runtime-pill-bool-true'
      : ' nc-runtime-pill-bool nc-runtime-pill-bool-false';
  }
  if (data.isUnknownTyped) cls += ' nc-runtime-pill-unknown';

  const canPoke = pokeEnabled && data.pokeKind !== null;
  if (canPoke) cls += ' nc-runtime-pill-pokeable';

  const canToggleBool = canPoke && data.pillType === 'BOOL' && !data.isMissing;

  const handleClick = canPoke
    ? () => setEditing({ nameLower, memberLower })
    : undefined;
  const handleDoubleClick = canToggleBool
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const flipped = !data.isBoolTrue;
        const newVal: ScalarValue = {
          kind: 'scalar', type: 'BOOL', value: flipped,
        };
        const result = data.pokeKind === 'unknown-member'
          ? pokeMember(env, nameLower, memberLower!, newVal, 0)
          : pokeVariable(env, nameLower, newVal, 0);
        if (result.ok) {
          setEditing(null);
          forceRender();
        }
      }
    : undefined;

  let tooltip = '';
  if (canToggleBool) tooltip = 'double-click to toggle, click to edit';
  else if (canPoke) tooltip = 'click to edit';

  return (
    <span
      className={cls}
      title={tooltip}
      role={canPoke ? 'button' : undefined}
      tabIndex={canPoke ? 0 : undefined}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {data.formattedValue}
    </span>
  );
}

// ---- Section tag -------------------------------------------------

function SectionTag({ section }: { section: VarSection }) {
  // Display label per section. INPUT / OUTPUT use the more
  // common short names; LOCAL is just "local" for the
  // unsuffixed VAR block. Color classes line up with the CSS.
  const meta: Record<VarSection, { label: string; cls: string }> = {
    INPUT:    { label: 'input',    cls: 'nc-runtime-watch-section-input' },
    OUTPUT:   { label: 'output',   cls: 'nc-runtime-watch-section-output' },
    IN_OUT:   { label: 'in_out',   cls: 'nc-runtime-watch-section-inout' },
    LOCAL:    { label: 'local',    cls: 'nc-runtime-watch-section-local' },
    TEMP:     { label: 'temp',     cls: 'nc-runtime-watch-section-temp' },
    GLOBAL:   { label: 'global',   cls: 'nc-runtime-watch-section-global' },
    EXTERNAL: { label: 'external', cls: 'nc-runtime-watch-section-external' },
  };
  const m = meta[section];
  return (
    <span className={`nc-runtime-watch-section ${m.cls}`}>{m.label}</span>
  );
}
