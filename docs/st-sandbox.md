# ST sandbox

A client-side runtime that executes TwinCAT 3 Structured Text
(ST) code blocks directly in the browser — no server, no PLC, no
TwinCAT runtime involved. It exists so you can paste a Function
Block exported from TwinCAT into a note, hit Run, and step
through its logic with live values, as a thinking/teaching aid.

It is **not** a PLC. There is no real I/O, no task scheduler, no
fieldbus, and no library of Beckhoff function blocks. It runs the
control flow and arithmetic of one POU's implementation, treats
everything it doesn't understand as a pokeable placeholder, and
lets you drive the rest by hand. That trade — run the parts we
can, stub the parts we can't, never refuse to run — is the whole
design.

The runtime lives entirely in the frontend. Source, AST, and
interpreter are under `src/NoteControl.Frontend/src/runtime/`; the
modal UI is `components/RuntimeModal.tsx`, the inline-value
rendering is `components/InlineSource.tsx`, and the variable
table is `components/WatchTable.tsx`. Nothing here touches the
server or the on-disk note beyond reading the code block's text.

## Opening the sandbox

Any code block whose language tag is **Structured Text (TwinCAT
3 ST)** — the custom lowlight language registered for the editor
(see `notes.md`) — gets a small **▶** run affordance. Clicking it
opens the ST sandbox modal for that block's contents.

The code block is parsed as a single POU. The runtime expects two
plain-text sections, the way a PLCopen XML export splits them:

- a **declaration** (`FUNCTION_BLOCK …` / `VAR …` / `VAR_INPUT …`
  / etc.), and
- an **implementation** (the body statements).

If the block came in via the PLCopen / TcPOU import path, those
two sections are already separated. If you typed it by hand, the
parser still splits on the first body statement.

## The modal

The modal is sized to dominate the viewport: `min(1600px, 95vw)`
wide and `88vh` tall, centred over a dim backdrop. Inside, the
body splits into two panes — **Declaration** (top, ~1/3 height)
and **Implementation** (bottom, ~2/3). Each pane scrolls
independently.

The title bar shows the POU name plus a quick summary, e.g.
`FB_XTS_Init · 29 variables · 6 statements`.

### Toolbar

- **Run** — start free-running scans at the selected cycle time.
- **Step** — execute exactly one scan, then pause.
- **Stop** — pause a running program (state is kept).
- **Reset** — rebuild the program state from scratch. See the
  caveat about pokes below.
- **Cycle** — the simulated scan interval (e.g. 10 ms). This
  drives the `TON`/`TOF` timers and the elapsed-time display; it
  is not wall-clock-accurate, it's the time each scan *claims* to
  advance.
- **scan / t** — a scan counter and the accumulated simulated
  time.

### Declaration pane: Source / Watch

A toggle in the Declaration pane switches between:

- **Source** — the raw declaration text, with line numbers.
- **Watch** — a table of every declared variable: name, type,
  current value (as a pill), and section (`INPUT`, `OUTPUT`,
  `LOCAL`, `EXTERNAL`, …). This is the live view you read while
  the program runs.

### Implementation pane

The implementation is shown with line numbers down the left
gutter. Inline with the code, **pills** render the live value of
variables and expressions at their position in the source. The
currently-executing line (or the line that raised an error) is
highlighted.

## Pills

A pill is the small boxed value rendered next to a variable, a
member access, or a chain expression in the implementation pane
(and in the Watch table's Value column).

- **Click** a pill to edit its value inline. Type a literal
  (`42`, `TRUE`, `1.5`, `'text'`, `T#200ms`) and press Enter.
- **Double-click** a BOOL pill to toggle it between TRUE and
  FALSE without opening the editor.

Pill colours:

- **TRUE** — solid blue, white text.
- **FALSE** — light grey, black text.
- **Numeric / string / time** — cream box.
- **Defaulted non-BOOL** (a value the runtime invented because
  nothing was poked — see below) — tinted to mark it as a
  placeholder rather than a computed value.
- **Unknown-sourced non-BOOL** (poked into a chain or unknown FB
  member) — a muted, dashed-border box, to hint that the value
  came from a stubbed source rather than a known-typed variable.

A poked value is a *real* value: it overrides any default and is
not styled as a placeholder. A defaulted BOOL renders as an
ordinary FALSE pill — the value FALSE is meaningful on its own,
so it isn't given placeholder styling.

## What the runtime executes natively

- **Control flow**: `IF/ELSIF/ELSE`, `CASE … OF` (including
  ranges and the `ELSE` branch), `FOR … TO … BY … DO`,
  `WHILE … DO`, `REPEAT … UNTIL`, `EXIT`, `CONTINUE`, `RETURN`.
- **Scalar types**: the usual ST integer family (`SINT`…`ULINT`),
  `REAL`/`LREAL`, `BOOL`, `STRING`, `TIME`. Assignment does the
  expected coercions and range handling.
- **Operators**: arithmetic, comparison, boolean, the usual
  precedence.
- **A small set of built-in function blocks**: **TON, TOF,
  R_TRIG, F_TRIG**. These tick correctly against the cycle time.
  Their member outputs (`.Q`, `.ET`, …) read as computed values,
  not pokeable stubs.

## The permissive-unknown model

The runtime has no schemas for user-defined or library types
(`Tc3_XTS_Utility.FB_TcIoXtsEnvironment`, `MC_Power`, your own
DUTs, etc.). Rather than refuse to run code that references them,
it accepts them as **unknown** and treats every read of an
unknown as a pokeable value.

Concretely, all of the following parse and run:

- **Namespaced / dotted type names** in declarations
  (`X : Tc3_XTS_Utility.FB_TcIoXtsEnvironment;`).
- **`ARRAY[…] OF T`** declarations, including multi-dimensional
  and namespaced element types. (The array is treated as one
  opaque unknown; there is no per-element storage in this
  version — see limitations.)
- **Chained method calls on unknown FBs**:
  `XtsEnvironment.XpuTcIo(1).GetAreAllModulesInOp()`.
- **Dotted assignment targets**:
  `MoverInterface.OverAllMoverSpeed_Pct := X;`.
- **Array indexing** in the body: `Mover[IDX]`,
  `fb_MC_Power[IDX].Error`, and the TwinCAT array-of-FBs call
  form `fb_MC_Power[IDX](Axis := Mover[IDX], Enable := TRUE)`.
- **Unknown built-in functions** (`CONCAT`, `TO_UINT`,
  `TO_STRING`, `UDINT_TO_…`, anything not in the small built-in
  set): their arguments are evaluated (so pills appear next to
  passed-in variables), and they return a sensible default.
- **Undeclared chain bases**: if a chain hangs off an identifier
  that isn't in any `VAR` block (a global like
  `XTS_Configuration.MoverCount`), the parser auto-declares it as
  a synthetic `EXTERNAL` unknown so the body still runs. These
  show in the Watch table with `(auto)` as their type.

### Default values

When an unknown read has no poked value, the runtime returns a
default rather than halting:

- BOOL → **FALSE**
- numeric → **0**
- string → **""**
- a `TO_<TYPE>(…)` call → that type's default

A defaulted value carries an internal flag so that, when it flows
into a typed assignment, the target's default is substituted
instead of raising a type error — e.g. a defaulted BOOL assigned
to a `UDINT` becomes `UDINT 0`, not a "cannot assign BOOL to
UDINT" halt.

The practical effect: **the program never halts because a value
is missing.** It runs at defaults, and you poke the values you
care about to steer it. A `FOR` loop bounded by an unknown count
runs zero times until you poke a count; an `IF` gated by an
unknown method reads FALSE until you toggle it. Poke a gate to
TRUE, the branch runs, the state machine advances.

## Poke identity (chain key)

Pokes are keyed by the **shape** of the chain, not the values
inside it. Method-call arguments and array indices collapse to
wildcards: `XpuTcIo(1).GetTrackCount()` and
`XpuTcIo(2).GetTrackCount()` share one pokeable slot, as do
`Mover[1]` and `Mover[2]`. The runtime has no schema to tell
those apart, so it gives them one identity. If you need to
distinguish them, introduce intermediate variables.

## Limitations

- **Pokes do not survive Reset.** Reset rebuilds program state
  from scratch, clearing every poked value back to defaults. With
  the default-FALSE policy this is usually a quick re-run rather
  than a hard stop, but a carefully built-up poke set is lost.
- **Chain shape is the poke key** (see above): indexed and
  argument-varied calls of the same shape are not distinguished.
- **Arrays have no per-element storage.** An `ARRAY[…] OF T` is
  one opaque unknown; indexing it is a chain step, not a real
  subscript into distinct cells.
- **Unknown function return values are defaults, not
  computations.** `TO_UINT(StationCount)` returns `0`, not the
  numeric value of `StationCount`. Trust the argument pills, not
  the return value.
- **No real FB library.** Only TON/TOF/R_TRIG/F_TRIG tick for
  real; every other FB call is a stubbed no-op returning a
  default.
- **The single-click editor opens after a short delay on BOOL
  pills** (so a double-click can be detected for the toggle).
  Other pill types open the editor immediately.
- **There is no Redo and no server-side persistence of runtime
  state.** Closing the modal discards the run.
