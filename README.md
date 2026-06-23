# Doc update — VFD widget + rail-header target hint

Documentation-only ship. Brings two docs in line with changes that
already shipped as code and were accepted:

1. the new **`vfd` note widget** (Drive control modes), Ships 1–5; and
2. the **rail-header `+` menu target-hint** shortening.

No code in this zip. Apply the two `.md` files into `docs/`; this
`README.md` is just the diff write-up.

---

## docs/note-widgets.md

**One addition** — a new entry in the **Kind catalog**, inserted
between `### convert` and `## Forward-compat`:

- `### vfd — Drive control modes (VFD)` — note-native widget. Documents:
  - the operating point (output frequency + load) and the three
    surfaces (capability chart, per-mode cards, attribute matrix);
  - the five modes (V/f, V/f + slip-comp, sensorless vector,
    closed-loop vector, DTC reference) and their vendor aliases;
  - the motor-type selector (induction / synchronous (PM) /
    reluctance) — synchronous types have no slip (rated-slip input
    disables), V/f is marginal for synchronous and not viable for
    reluctance;
  - the simplified model (synchronous speed, per-mode droop,
    per-type torque ceiling, field-weakening above base);
  - payload `VfdBlockDto`; default height 480 px.

Nothing else in this file changed.

## docs/frontend.md

**Three small edits:**

- **§ Properties panel** — the inline **＋ Add Note Widget** kind list
  ("RSS, Task, Links, Motion A–D, Motor compare, Unit converter")
  gains **"Drive control modes"**.
- **§ Note widgets** — the **Available kinds** bullet list gains a
  **"Drive control modes (VFD)"** bullet after Unit converter.
- **§ Tree rail header** — the `+` menu **target-folder hint**
  paragraph now describes the shortened display: the hint shows only
  the deepest folder name (e.g. `in AF1000`, not the full
  `MOTION/HARDWARE/AF1000`), ellipsis-capped if that name is long,
  full path on hover. Previously it described showing the full
  resolved target ("in vault root", "into Projects/Q4"). The
  target-selection rule sentence after it is unchanged.

## Not changed

- **storage.md** — uses `motor` only as a schema example and points to
  note-widgets.md for the catalog; still accurate.
- **api.md** — the note-widgets endpoints are generic (whole-map
  GET/PUT); the new kind needs no endpoint change.
