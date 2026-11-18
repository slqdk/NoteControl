import {
  detectFamilyIn,
  familyFromTextIn,
  type TKFamily,
  type TKField,
  type TKValue,
} from './typeKeys';

/**
 * Beckhoff type keys (order codes) for the "typekey" note widget.
 *
 * Built from the 2022 hand-made diagrams (AM, AL, AMI, AS, AA, AX5000,
 * AX8000, EL70xx, EL72xx, ELM72xx) and checked against the current
 * Beckhoff documentation on TYPE_KEY_VERIFIED. Every difference is marked
 * on the value rather than silently changed:
 *   status 'new'   — added since the diagrams (current docs),
 *   status 'check' — in the diagram, not found in the current docs,
 *   status 'fixed' — corrected; `was` holds the diagram's wording.
 *
 * To change a key, edit the data here — the engine (typeKeys.ts) and the
 * widget need no change. The server stores only the selected family id
 * and the code.
 */

export const TYPE_KEY_VERIFIED = '2026-11-18';

const ANY_LETTER = { pattern: /^[A-Z]$/, text: 'winding code' };
const NOT_USED: TKField['open'] = { pattern: /^[0-9A-Z]$/, text: 'not used' };

function lengths(codes: string[], word = 'length'): TKValue[] {
  return codes.map((c) => ({ code: c, text: `${word} ${c}` }));
}

const FROM_F3 = ['3', '4', '5', '6', '7'];
const FROM_F5 = ['5', '6', '7'];

export const TYPE_KEY_FAMILIES: TKFamily[] = [
  // ======================================================================
  // Motors
  // ======================================================================
  {
    id: 'am8000',
    short: 'AM8000',
    name: 'Servomotors AM8000 / AM8100 / AM8300 / AM8500 / AM8700 / AM8800',
    group: 'Motors',
    template: 'AM8tuv-wxyz[-a000]',
    detect: /^AM8/,
    hint: /AM8\d{3}/i,
    example: 'AM8044-1JH0',
    fields: [
      {
        key: 't',
        label: 'Motor series',
        values: [
          { code: '0', text: 'AM8000 · 400 V' },
          { code: '1', text: 'AM8100 · 48 V' },
          { code: '3', text: 'AM8300 · 400 V, water cooling' },
          { code: '5', text: 'AM8500 · 400 V, increased rotor inertia' },
          { code: '7', text: 'AM8700 · 400 V, anodized aluminium housing' },
          { code: '8', text: 'AM8800 · stainless steel, hygienic design' },
        ],
      },
      {
        key: 'u',
        label: 'Flange size',
        values: [
          { code: '1', text: 'F1 · 40 mm' },
          { code: '2', text: 'F2 · 58 mm' },
          { code: '3', text: 'F3 · 72 mm' },
          { code: '4', text: 'F4 · 87 mm' },
          { code: '5', text: 'F5 · 104 mm' },
          { code: '6', text: 'F6 · 142 mm' },
          { code: '7', text: 'F7 · 194 mm' },
        ],
      },
      { key: 'v', label: 'Overall length', values: lengths(['1', '2', '3', '4']) },
      {
        key: 'w',
        label: 'Shaft version',
        values: [
          { code: '0', text: 'smooth shaft' },
          { code: '1', text: 'groove and feather key (DIN 6885)' },
          { code: '2', text: 'IP65 shaft-sealing ring, smooth shaft' },
          { code: '3', text: 'IP65 shaft-sealing ring, groove and feather key' },
          { code: '4', text: 'IP65 shaft-sealing ring, smooth shaft, sealing-air connection' },
          { code: '5', text: 'IP65 shaft-sealing ring, groove and feather key, sealing-air connection' },
        ],
        note: 'AM8100: the sealing ring (2, 3) only for AM812x–AM814x.',
      },
      {
        key: 'x',
        label: 'Winding type',
        values: [{ code: 'S', text: 'special winding' }],
        open: ANY_LETTER,
      },
      {
        key: 'y',
        label: 'Feedback system',
        values: [
          { code: '0', text: 'resolver, two-pole (separate feedback cable)' },
          { code: '1', text: 'OCT single-turn, 18 bit' },
          { code: '2', text: 'OCT multi-turn (4096 rev), 18 bit' },
          { code: '3', text: 'Hiperface single-turn, 128 SinCos', when: { u: ['6', '7'] }, whenText: 'from flange F6' },
          { code: '4', text: 'Hiperface multi-turn, 128 SinCos', when: { u: ['6', '7'] }, whenText: 'from flange F6' },
          { code: 'A', text: 'OCT single-turn, 23 bit', status: 'check' },
          { code: 'B', text: 'OCT multi-turn, 23 bit', status: 'check' },
          { code: 'G', text: 'OCT single-turn, 24 bit, SIL 2' },
          { code: 'H', text: 'OCT multi-turn (4096 rev), 24 bit, SIL 2' },
          {
            code: 'I',
            text: 'EnDat 3 (OCT) single-turn, 19 bit, SIL 3',
            status: 'new',
            when: { u: FROM_F3 },
            whenText: 'from flange F3 (> 58 mm)',
            note: 'AX8000 from firmware 1.06',
          },
          {
            code: 'J',
            text: 'EnDat 3 (OCT) multi-turn (4096 rev, battery-free), 19 bit, SIL 3',
            status: 'new',
            when: { u: FROM_F3 },
            whenText: 'from flange F3 (> 58 mm)',
          },
          {
            code: 'L',
            text: 'OCT multi-turn (4096 rev), 24 bit, SIL 2 + B/SSD (Smart System Diagnosis)',
            status: 'new',
          },
          { code: 'N', text: 'no feedback ("sensorless")' },
        ],
        note: 'G…L are SIL 2/3-capable — required for TwinSAFE Safe Motion on AX8xxx-x2xx.',
      },
      {
        key: 'z',
        label: 'Holding brake / fan',
        values: [
          { code: '0', text: 'without holding brake' },
          { code: '1', text: '24 V holding brake' },
          { code: 'A', text: '24 V fan; without holding brake', when: { u: FROM_F5 }, whenText: 'from flange F5' },
          { code: 'B', text: '24 V fan; 24 V holding brake', when: { u: FROM_F5 }, whenText: 'from flange F5' },
          { code: 'C', text: '24 V fan, IP65; without holding brake', when: { u: FROM_F5 }, whenText: 'from flange F5' },
          { code: 'D', text: '24 V fan, IP65; 24 V holding brake', when: { u: FROM_F5 }, whenText: 'from flange F5' },
        ],
      },
      {
        key: 'a',
        label: 'Version',
        values: [
          { code: '0', text: 'standard' },
          { code: '1', text: 'special version' },
          { code: '9', text: 'AM3000 flange' },
        ],
      },
    ],
    note: 'beckhoff.com writes open options in lower case, e.g. AM8044-wJyz — paste it as is.',
    sources: [
      'AM8000 product pages, order reference AM80uv-wxyz',
      'AX8000 operating instructions: feedback G…L for TwinSAFE',
      'Ordering-option pages: EnDat 3 (I, J), B/SSD (L)',
      'Your 2022 diagram',
    ],
  },
  {
    id: 'am1000',
    short: 'AM1000',
    name: 'Economy servomotors AM1000',
    group: 'Motors',
    status: 'new',
    template: 'AM10uv-wxyz',
    detect: /^AM10/,
    hint: /AM10\d{2}/i,
    example: 'AM1031-1H20',
    fields: [
      {
        key: 'u',
        label: 'Flange code',
        values: [
          { code: '1', text: 'I1 · 40 mm' },
          { code: '2', text: 'I2 · 60 mm' },
          { code: '3', text: 'I3 · 80 mm' },
        ],
      },
      { key: 'v', label: 'Motor length', values: lengths(['1', '2', '3']) },
      {
        key: 'w',
        label: 'Shaft version',
        values: [
          { code: '0', text: 'plain shaft' },
          { code: '1', text: 'keyway and feather key (DIN 6885)' },
          { code: '2', text: 'plain shaft, IP65 seal ring' },
          { code: '3', text: 'keyway and feather key, IP65 seal ring' },
        ],
      },
      { key: 'x', label: 'Winding type', values: [], open: { pattern: /^[A-Z]$/, text: 'winding code (D, F, H, J …)' } },
      {
        key: 'y',
        label: 'Feedback system',
        values: [
          { code: '1', text: 'OCT single-turn absolute encoder, electronic nameplate' },
          { code: '2', text: 'OCT multi-turn absolute encoder (battery-free), electronic nameplate' },
        ],
      },
      {
        key: 'z',
        label: 'Holding brake',
        values: [
          { code: '0', text: 'without holding brake' },
          { code: '1', text: 'with holding brake' },
        ],
      },
    ],
    note: 'Economy series, pairs with AX1000. Product announcement — market release Q4 2026 / Q1 2027 depending on the product page.',
    sources: ['AM1000 product pages, order reference AM10uv-wxyz'],
  },
  {
    id: 'ami8100',
    short: 'AMI8100',
    name: 'Compact integrated servo drives AMI8100',
    group: 'Motors',
    template: 'AMI81uv-ab00-wxyz',
    detect: /^AMI8/,
    hint: /AMI8\d{3}/i,
    example: 'AMI8131-4100-1J10',
    fields: [
      {
        key: 'u',
        label: 'Flange size',
        status: 'fixed',
        values: [
          { code: '2', text: 'F2 · 58 mm' },
          { code: '3', text: 'F3 · 72 mm' },
        ],
        note: 'Your diagram listed flange 1–7 (as AM8000); the current key has F2 and F3.',
      },
      {
        key: 'v',
        label: 'Overall length',
        status: 'fixed',
        values: lengths(['1', '2', '3']),
        note: 'Empty in your diagram.',
      },
      {
        key: 'a',
        label: 'Feedback system',
        values: [
          { code: '3', text: 'single-turn absolute encoder, 17 bit' },
          { code: '4', text: 'multi-turn absolute encoder (65,536 rev), 17 bit' },
        ],
      },
      {
        key: 'b',
        label: 'Drive-integrated safety',
        values: [
          { code: '0', text: 'without TwinSAFE' },
          { code: '1', text: 'TwinSAFE: STO, integrated TwinSAFE Logic' },
        ],
      },
      {
        key: 'w',
        label: 'Shaft version',
        values: [
          { code: '0', text: 'smooth shaft' },
          { code: '1', text: 'groove and feather key (DIN 6885)' },
          { code: '2', text: 'IP65 shaft-sealing ring, smooth shaft' },
          { code: '3', text: 'IP65 shaft-sealing ring, groove and feather key' },
        ],
      },
      { key: 'x', label: 'Winding type', values: [{ code: 'S', text: 'special winding' }], open: ANY_LETTER },
      {
        key: 'y',
        label: 'Communication interface',
        values: [
          { code: '1', text: 'EtherCAT, MDP profile (preferred)' },
          { code: '2', text: 'EtherCAT, DS402 profile', status: 'new' },
        ],
      },
      {
        key: 'z',
        label: 'Holding brake',
        values: [
          { code: '0', text: 'without holding brake' },
          { code: '1', text: '24 V DC holding brake' },
        ],
      },
    ],
    sources: ['AMI8100 operating instructions: type key (Infosys)', 'AMI8131 product page'],
  },
  {
    id: 'as1000',
    short: 'AS1000',
    name: 'Stepper motors AS1000',
    group: 'Motors',
    template: 'AS10uv-wxyz',
    detect: /^AS10/,
    hint: /AS10\d{2}/i,
    example: 'AS1060-1120',
    fields: [
      {
        key: 'uv',
        label: 'Motor',
        values: [
          { code: '10', text: 'AS1010 · 0.38 Nm, 1.0 A' },
          { code: '20', text: 'AS1020 · 0.5 Nm, 1.0 A' },
          { code: '30', text: 'AS1030 · 0.6 Nm, 1.5 A' },
          { code: '50', text: 'AS1050 · 1.2 Nm, 5.0 A' },
          { code: '60', text: 'AS1060 · 5.0 Nm, 5.0 A, NEMA34 (N3)' },
        ],
      },
      {
        key: 'w',
        label: 'Shaft version',
        values: [
          { code: '0', text: 'smooth shaft with 2 flats' },
          { code: '1', text: 'groove and feather key (DIN 6885)', when: { uv: ['60'] }, whenText: 'on AS1060' },
        ],
      },
      {
        key: 'x',
        label: 'Second shaft',
        values: [
          { code: '0', text: 'standard, no second shaft' },
          {
            code: '1',
            text: 'second shaft (needed for an encoder)',
            when: { uv: ['20', '50', '60'] },
            whenText: 'on AS1020 / AS1050 / AS1060',
          },
        ],
      },
      {
        key: 'y',
        label: 'Encoder',
        values: [
          { code: '0', text: 'no encoder' },
          { code: '1', text: 'incremental, 24 V DC, 200 increments', when: { x: ['1'] }, whenText: 'with x = 1 (second shaft)' },
          { code: '2', text: 'incremental, 24 V DC, 1024 increments', when: { x: ['1'] }, whenText: 'with x = 1 (second shaft)' },
        ],
      },
      { key: 'z', label: 'Version', values: [{ code: '0', text: 'standard' }] },
    ],
    note: 'Flange 42–86 mm (N1 = NEMA17, N2 = NEMA23, N3 = NEMA34), 0.4–5 Nm. Your diagram had one key for AS1000 and AS2000 ("ASg0uv-wxyz"); they are separate keys.',
    sources: ['AS1060 product page, order reference', 'AS1000 operating instructions (torque, current)'],
  },
  {
    id: 'as2000',
    short: 'AS2000',
    name: 'Stepper motors AS2000',
    group: 'Motors',
    template: 'AS20uv-wxyz',
    detect: /^AS20/,
    hint: /AS20\d{2}/i,
    example: 'AS2041-1H10',
    fields: [
      {
        key: 'u',
        label: 'Flange size',
        values: [
          { code: '2', text: 'N2 · NEMA23 (58 mm)' },
          { code: '4', text: 'N3 · NEMA34 (86 mm)' },
        ],
      },
      {
        key: 'v',
        label: 'Overall length',
        values: [
          { code: '1', text: 'one stack' },
          { code: '2', text: 'two stacks' },
          { code: '3', text: 'three stacks' },
        ],
      },
      {
        key: 'w',
        label: 'Shaft version',
        values: [
          { code: '0', text: 'smooth shaft' },
          { code: '1', text: 'groove and feather key (DIN 6885)', when: { u: ['4'] }, whenText: 'on AS204x' },
        ],
      },
      {
        key: 'x',
        label: 'Winding type',
        values: [
          { code: 'D', text: '2 A' },
          { code: 'H', text: '5…6 A' },
          { code: 'J', text: '< 8 A' },
        ],
      },
      {
        key: 'y',
        label: 'Encoder',
        values: [
          { code: '0', text: 'no encoder', status: 'new' },
          { code: '1', text: 'encoder 24 V DC, 1024 increments (EL7037, EL7047)' },
          { code: '2', text: 'encoder 5 V DC (DIFF RS422, TTL), 1024 increments (EL7062)', status: 'new' },
        ],
      },
      { key: 'z', label: 'Holding brake', values: [{ code: '0', text: 'without holding brake' }] },
    ],
    note: 'Your diagram ("ASg0uv-wxyz", g = generation) is this key with g = 2.',
    sources: ['AS2041 product page, order reference', 'AS2000 ordering option: 5 V TTL encoder', 'Your 2022 diagram'],
  },
  {
    id: 'al8000',
    short: 'AL8000',
    name: 'Linear servomotors AL8000 / AL8100',
    group: 'Motors',
    template: 'AL8tuv-wxyz-0000',
    detect: /^AL8/,
    hint: /AL8\d{3}/i,
    example: 'AL8043-0G11-0000',
    fields: [
      {
        key: 't',
        label: 'Motor series',
        values: [
          { code: '0', text: 'AL8000 · 400 V AC' },
          { code: '1', text: 'AL8100 · 48 V DC', status: 'fixed', was: '24 V DC' },
        ],
      },
      {
        key: 'u',
        label: 'Overall width',
        values: [
          { code: '2', text: 'W2 · 50 mm' },
          { code: '4', text: 'W4 · 80 mm' },
          { code: '6', text: 'W6 · 130 mm' },
        ],
      },
      {
        key: 'v',
        label: 'Overall length',
        values: [
          { code: '1', text: '3' },
          { code: '2', text: '6' },
          { code: '3', text: '9' },
          { code: '4', text: '12' },
          { code: '5', text: '15' },
          { code: '6', text: '18' },
          { code: '8', text: '24' },
          { code: 'A', text: '30' },
          { code: 'F', text: '45' },
        ],
        note: 'Values as in your diagram (no unit given). Example: AL8043 (v = 3) has a 191 mm primary part.',
      },
      {
        key: 'w',
        label: 'Cooling',
        values: [
          { code: '0', text: 'convection (air-cooled)' },
          { code: '1', text: 'water cooling' },
        ],
      },
      { key: 'x', label: 'Winding type', values: [{ code: 'S', text: 'special winding' }], open: ANY_LETTER },
      {
        key: 'y',
        label: 'Feedback system',
        values: [
          { code: '0', text: 'without feedback' },
          {
            code: '1',
            text: 'OCT: inductive scanning head, absolute, 0.1 µm, electronic nameplate',
            status: 'new',
            note: 'market release on request',
          },
        ],
      },
      {
        key: 'z',
        label: 'Connection',
        values: [
          { code: '0', text: '1.00 m cable with wire-end ferrules (no plug)' },
          { code: '1', text: '0.50 m cable with plug (preferred)' },
        ],
      },
    ],
    sources: ['AL8043 product page, order reference', 'AL8000 / AL8100 OCT page', 'Your 2022 diagram'],
  },
  {
    id: 'aa3000',
    short: 'AA3000',
    name: 'Electric cylinders AA3000',
    group: 'Motors',
    template: 'AA3tuv-wxyz-a000',
    detect: /^AA3/,
    hint: /AA3\d{3}/i,
    example: 'AA3033-23H0-0000',
    fields: [
      { key: 't', label: 'Motor series', values: [{ code: '0', text: 'standard' }] },
      {
        key: 'u',
        label: 'Flange size',
        values: [
          { code: '2', text: '58 mm' },
          { code: '3', text: '75 mm' },
          { code: '5', text: '110 mm' },
        ],
      },
      { key: 'v', label: 'Overall length', values: [{ code: '3', text: 'standard' }] },
      {
        key: 'w',
        label: 'Spindle pitch / anti-twist protection',
        values: [
          { code: '1', text: '5 mm, without anti-twist protection' },
          { code: '2', text: '5 mm, with anti-twist protection' },
          { code: '3', text: '10 mm, without anti-twist protection' },
          { code: '4', text: '10 mm, with anti-twist protection' },
          { code: '5', text: '20 mm, without anti-twist protection' },
          { code: '6', text: '20 mm, with anti-twist protection' },
          { code: '9', text: 'special pitch' },
        ],
      },
      {
        key: 'x',
        label: 'Stroke',
        values: [
          { code: '2', text: '150 mm' },
          { code: '3', text: '200 mm' },
          { code: '4', text: '250 mm' },
          { code: '9', text: 'special stroke' },
        ],
      },
      {
        key: 'y',
        label: 'Feedback system',
        values: [
          { code: 'H', text: 'OCT multi-turn (4096 rev), 24 bit, SIL 2' },
          {
            code: 'J',
            text: 'EnDat 3 (OCT) multi-turn (4096 rev), 19 bit, SIL 3',
            status: 'new',
            note: 'AX8000 from firmware 1.07',
          },
        ],
      },
      {
        key: 'z',
        label: 'Holding brake',
        values: [
          { code: '0', text: 'without holding brake' },
          { code: '1', text: '24 V holding brake (permanent magnet)' },
        ],
      },
      {
        key: 'a',
        label: 'Version',
        values: [
          { code: '0', text: 'standard' },
          { code: '1', text: 'special variant' },
        ],
      },
    ],
    sources: ['AA3033 product pages, order reference', 'Your 2022 diagram'],
  },

  // ======================================================================
  // Drives
  // ======================================================================
  {
    id: 'ax5000',
    short: 'AX5000',
    name: 'Servo drives AX5000',
    group: 'Drives',
    template: 'AX5xyz-abcd-efgh',
    detect: /^AX5/,
    hint: /AX5\d{3}/i,
    example: 'AX5106-0000-0202',
    fields: [
      {
        key: 'x',
        label: 'Channels',
        values: [
          { code: '1', text: '1 channel' },
          { code: '2', text: '2 channels' },
        ],
      },
      {
        key: 'yz',
        label: 'Rated current per channel',
        values: [
          { code: '01', text: '1.5 A' },
          { code: '03', text: '3.0 A' },
          { code: '06', text: '6.0 A (single-phase: 4.5 A)', when: { x: ['1'] } },
          { code: '06', text: '6.0 A', when: { x: ['2'] } },
          { code: '12', text: '12 A', when: { x: ['1'] } },
          { code: '18', text: '18 A', when: { x: ['1'] } },
          { code: '25', text: '25 A', when: { x: ['1'] } },
          { code: '40', text: '40 A', when: { x: ['1'] } },
          { code: '60', text: '60 A', when: { x: ['1'] } },
          { code: '72', text: '72 A', when: { x: ['1'] } },
          { code: '90', text: '90 A', when: { x: ['1'] } },
          { code: '91', text: '110 A (three-phase)', when: { x: ['1'] }, status: 'fixed', was: 'listed under 2-channel' },
          { code: '92', text: '143 A (three-phase)', when: { x: ['1'] }, status: 'fixed', was: 'listed under 2-channel' },
          { code: '93', text: '170 A (three-phase)', when: { x: ['1'] }, status: 'fixed', was: 'listed under 2-channel' },
        ],
      },
      {
        key: 'abcd',
        label: 'Options',
        values: [{ code: '0000', text: 'standard' }],
        open: { pattern: /^[0-9A-Z]{4}$/, text: 'not described in the current type key' },
      },
      {
        key: 'e',
        label: 'Variant',
        values: [
          { code: '0', text: 'standard' },
          { code: '1', text: 'special / customer-specific', status: 'fixed', was: '2' },
        ],
      },
      {
        key: 'f',
        label: 'Hardware version',
        values: [
          { code: '0', text: 'first generation (HW1)' },
          { code: '2', text: 'second generation (HW2)' },
        ],
      },
      {
        key: 'g',
        label: 'Dual use',
        values: [
          { code: '0', text: '≤ 599 Hz — not dual use' },
          { code: '1', text: '> 599 Hz — dual use (export control)' },
        ],
      },
      {
        key: 'h',
        label: 'Firmware version',
        values: [
          { code: '0', text: 'v2.06' },
          { code: '2', text: '≥ v2.10' },
        ],
      },
    ],
    sources: ['AX5000 system manual HW2: type key (Infosys)', 'Your 2022 diagram'],
  },
  {
    id: 'ax8000',
    short: 'AX8000',
    name: 'Multi-axis servo system AX8000',
    group: 'Drives',
    template: 'AX8xyz-abcd-efg0',
    detect: /^AX8/,
    hint: /AX8\d{3}/i,
    example: 'AX8108-0210-0000',
    fields: [
      {
        key: 'x',
        label: 'Module type',
        values: [
          { code: '1', text: 'axis module, 1 channel (AX81xx)' },
          { code: '2', text: 'axis module, 2 channels (AX82xx)' },
          { code: '5', text: 'combined power supply + axis module (AX85xx)' },
          { code: '6', text: 'power supply module (AX86xx)' },
          { code: '8', text: 'option module (AX88xx)' },
        ],
      },
      {
        key: 'yz',
        label: 'Rated current',
        values: [
          { code: '00', text: 'DC power supply, max. 50 A DC (AX8600)', when: { x: ['6'] } },
          { code: '20', text: '20 A DC three-phase / 7 A DC single-phase (AX8620)', when: { x: ['6'] } },
          { code: '40', text: '40 A DC, three-phase (AX8640)', when: { x: ['6'] } },
          { code: '06', text: '2 × 6 A', when: { x: ['2'] } },
          { code: '08', text: '1 × 8 A', when: { x: ['1'] } },
          { code: '18', text: '1 × 18 A', when: { x: ['1'] } },
          { code: '28', text: '1 × 28 A', when: { x: ['1'] }, status: 'new' },
          { code: '12', text: '12 A', status: 'check' },
          { code: '25', text: '25 A AC (AX8525)', when: { x: ['5'] } },
          { code: '40', text: '40 A AC (AX8540)', when: { x: ['5'] } },
          { code: '31', text: 'coupling module, 1 channel (AX8831)', when: { x: ['8'] }, status: 'new' },
          { code: '32', text: 'coupling module, 2 channels (AX8832)', when: { x: ['8'] }, status: 'new' },
        ],
      },
      { key: 'a', label: 'DC link voltage', status: 'new', values: [{ code: '0', text: '0 … 848 V DC' }] },
      {
        key: 'b',
        label: 'Safety function',
        values: [
          { code: '0', text: 'no safety function' },
          { code: '1', text: 'TwinSAFE STO/SS1' },
          {
            code: '2',
            text: 'TwinSAFE Safe Motion (17 safety functions) with TwinSAFE Logic',
            status: 'fixed',
            was: 'TwinSAFE Logic',
          },
        ],
      },
      {
        key: 'c',
        label: 'Hardware features (feedback)',
        values: [
          { code: '0', text: 'OCT / EnDat 3 (standard)' },
          { code: '1', text: 'multi-feedback: EnDat 2.2/22, BiSS C' },
          {
            code: '2',
            text: 'multi-feedback: EnDat 2.2/22, BiSS C, TTL (DIFF RS422), SinCos 1 Vpp',
            when: { x: ['1'] },
            whenText: 'on 1-channel modules',
          },
        ],
      },
      { key: 'd', label: 'Version', values: [{ code: '0', text: 'standard' }] },
      { key: 'e', label: 'Version', values: [{ code: '0', text: 'standard' }] },
      { key: 'f', label: 'Version', values: [{ code: '0', text: 'standard' }] },
      {
        key: 'g',
        label: 'Dual use',
        values: [
          { code: '0', text: '≤ 599 Hz — not dual use' },
          { code: '8', text: '≥ 600 Hz — dual use (export control)' },
        ],
      },
    ],
    note: 'Beckhoff keeps separate keys for AX86xx and AX85xx; this merged view follows your diagram.',
    sources: [
      'AX8000 operating instructions: type key AX81xx/AX82xx (Infosys)',
      'Servo drives tabular product overview',
      'Your 2022 diagram',
    ],
  },
  {
    id: 'ax1000',
    short: 'AX1000',
    name: 'Economy servo drives AX1000',
    group: 'Drives',
    status: 'new',
    template: 'AX1bcd-efgh-ijkl',
    detect: /^AX1/,
    hint: /AX1\d{3}/i,
    example: 'AX1101-1301-0000',
    fields: [
      {
        key: 'b',
        label: 'Axes',
        values: [
          { code: '1', text: 'single-axis module' },
          { code: '2', text: 'dual-axis module' },
        ],
      },
      {
        key: 'cd',
        label: 'Rated output current',
        values: [
          { code: '01', text: '1.65 A' },
          { code: '03', text: '3.4 A', when: { b: ['1'] } },
          { code: '03', text: '3.0 A', when: { b: ['2'] } },
          { code: '06', text: '6.9 A', when: { b: ['1'] } },
          { code: '06', text: '6.0 A', when: { b: ['2'] } },
          {
            code: '12',
            text: '12 A (AX1112-3xxx)',
            when: { b: ['1'], e: ['3'] },
            whenText: 'single-axis, three-phase',
            note: 'In the product range, missing from the type-key table',
          },
        ],
      },
      {
        key: 'e',
        label: 'Supply',
        values: [
          { code: '1', text: 'single-phase, 1 × 110…240 V AC' },
          { code: '3', text: 'three-phase, 3 × 208…480 V AC' },
        ],
      },
      {
        key: 'fg',
        label: 'TwinSAFE',
        values: [
          { code: '10', text: 'STO/SS1 via FSoE' },
          { code: '20', text: 'STO/SS1 via FSoE and I/O' },
          { code: '30', text: 'Safe Motion via FSoE' },
        ],
      },
      { key: 'h', label: 'Device type', values: [{ code: '1', text: 'standard' }] },
      { key: 'i', label: 'Version', values: [{ code: '0', text: 'standard' }] },
      { key: 'j', label: 'Not used', values: [{ code: '0', text: '—' }], open: NOT_USED },
      {
        key: 'k',
        label: 'Dual use',
        values: [
          { code: '0', text: 'no dual use' },
          { code: '8', text: 'dual use — rotary field > 599 Hz, may need an export licence' },
        ],
      },
      { key: 'l', label: 'Not used', values: [{ code: '0', text: '—' }], open: NOT_USED },
    ],
    note: 'OCT feedback; pairs with AM1000.',
    sources: ['AX1000 operating instructions v1.0.0: type key (3.2), ordering options (3.4)'],
  },
  {
    id: 'af1000',
    short: 'AF1000',
    name: 'Economy variable frequency drives AF1000',
    group: 'Drives',
    status: 'new',
    template: 'AF1bcd-efgh-ijkl',
    detect: /^AF1/,
    hint: /AF1\d{3}/i,
    example: 'AF1103-1200-0000',
    fields: [
      {
        key: 'b',
        label: 'Axes',
        values: [
          { code: '1', text: 'single-axis module' },
          { code: '2', text: 'dual-axis module' },
        ],
      },
      {
        key: 'cd',
        label: 'Recommended motor power',
        values: [
          { code: '03', text: '0.37 kW' },
          { code: '07', text: '0.75 kW' },
          { code: '15', text: '1.5 kW' },
          { code: '22', text: '2.2 kW' },
          { code: '30', text: '3.0 kW' },
          { code: '55', text: '5.5 kW' },
        ],
      },
      {
        key: 'e',
        label: 'Supply',
        values: [
          { code: '1', text: 'single-phase, 1 × 110…240 V AC' },
          { code: '3', text: 'three-phase, 3 × 208…480 V AC' },
        ],
      },
      {
        key: 'fg',
        label: 'TwinSAFE',
        values: [
          { code: '00', text: 'without safety' },
          { code: '10', text: 'STO/SS1 via FSoE' },
          { code: '20', text: 'STO/SS1 via FSoE and I/O' },
        ],
      },
      { key: 'h', label: 'Not used', values: [{ code: '0', text: '—' }], open: NOT_USED },
      { key: 'i', label: 'Version', values: [{ code: '0', text: 'standard' }] },
      { key: 'j', label: 'Not used', values: [{ code: '0', text: '—' }], open: NOT_USED },
      {
        key: 'k',
        label: 'Dual use',
        values: [
          { code: '0', text: 'no dual use' },
          { code: '8', text: 'dual use (export control)' },
        ],
      },
      { key: 'l', label: 'Not used', values: [{ code: '0', text: '—' }], open: NOT_USED },
    ],
    note: 'For synchronous, asynchronous and reluctance motors without feedback.',
    sources: ['AF1000 operating instructions v1.0.1: type key (3.2), ordering options (3.4)'],
  },

  // ======================================================================
  // EtherCAT Terminals (compact drive technology)
  // ======================================================================
  {
    id: 'el70xx',
    short: 'EL70xx',
    name: 'Stepper motor terminals EL70xx',
    group: 'Terminals',
    template: 'EL70yz[-abcd]',
    detect: /^EL70/,
    hint: /EL70(\d{2}|xx)/i,
    example: 'EL7047-9014',
    fields: [
      {
        key: 'y',
        label: 'Voltage',
        values: [
          { code: '3', text: '24 V DC (EL703x, 1.5 A)' },
          { code: '4', text: '48 V DC (EL704x, 5 A)' },
          { code: '6', text: '48 V DC, 5 V encoder supply (EL7062, 3 A)' },
        ],
      },
      {
        key: 'z',
        label: 'Function',
        values: [
          { code: '1', text: '1 channel' },
          { code: '2', text: '2 channels' },
          { code: '7', text: '1 channel with vector control' },
        ],
      },
      {
        key: 'abcd',
        label: 'Variant / safety',
        values: [
          { code: '', text: 'standard (no suffix)' },
          { code: '0030', text: '2.8 A, 24 V DC (EL7031-0030)', status: 'new' },
          { code: '0052', text: '5 A, 48 V DC, listed without encoder input (EL7041-0052)', status: 'new' },
          { code: '9014', text: 'STO input (e.g. EL7047-9014)' },
          { code: '0010', text: 'no safety', status: 'check' },
          { code: '9016', text: 'TwinSAFE Logic & STO/SS1', status: 'check' },
        ],
      },
    ],
    note: 'EL7041 and EL7037/EL7047 read an incremental encoder; EL7062 is 2-channel with a 5 V encoder supply.',
    sources: ['EL/ELM7xxx tabular product overview', 'EL7047-9014 and EL7041-0052 product pages', 'Your 2022 diagram'],
  },
  {
    id: 'el72xx',
    short: 'EL72xx',
    name: 'Servo terminals EL72xx (48 V)',
    group: 'Terminals',
    template: 'EL72yz[-abcd]',
    detect: /^EL72/,
    hint: /EL72(\d{2}|xx)/i,
    example: 'EL7211-0010',
    fields: [
      {
        key: 'y',
        label: 'Channel output',
        values: [
          { code: '0', text: '2.8 A' },
          { code: '1', text: '4.5 A' },
          { code: '2', text: '8 A (7…8 A with ZB8610 fan)' },
        ],
      },
      {
        key: 'z',
        label: 'Channels',
        values: [
          { code: '1', text: '1 channel' },
          { code: '2', text: '2 channels', status: 'check' },
        ],
      },
      {
        key: 'abcd',
        label: 'Feedback / safety',
        values: [
          { code: '', text: 'resolver, no safety (EL7201, EL7211)', status: 'new' },
          { code: '0010', text: 'OCT, no safety' },
          { code: '9014', text: 'OCT + STO input' },
          { code: '9016', text: 'TwinSAFE Logic & STO/SS1', status: 'check' },
          { code: '9018', text: 'TwinSAFE Logic & STO/SS1 + further functions', status: 'check' },
        ],
        note: 'In the current range 9016 / 9018 are ELM72xx suffixes.',
      },
    ],
    note: 'For 48 V motors (AM8100, AL8100).',
    sources: ['EL/ELM7xxx tabular product overview', 'EL7211 product page', 'Your 2022 diagram'],
  },
  {
    id: 'elm72xx',
    short: 'ELM72xx',
    name: 'Servo terminals ELM72xx (48 V)',
    group: 'Terminals',
    template: 'ELM72yz[-abcd]',
    detect: /^ELM72/,
    hint: /ELM72(\d{2}|xx)/i,
    example: 'ELM7231-9018',
    fields: [
      {
        key: 'y',
        label: 'Channel output',
        values: [
          { code: '1', text: '4.5 A' },
          { code: '2', text: '8 A' },
          { code: '3', text: '16 A' },
        ],
      },
      {
        key: 'z',
        label: 'Channels',
        values: [
          { code: '1', text: '1 channel' },
          { code: '2', text: '2 channels' },
        ],
      },
      {
        key: 'abcd',
        label: 'Safety',
        values: [
          { code: '0010', text: 'no safety' },
          { code: '9014', text: 'STO input only', status: 'check' },
          { code: '9016', text: 'TwinSAFE Logic & STO/SS1' },
          { code: '9018', text: 'TwinSAFE Logic & Safe Motion (STO/SS1 + further functions)' },
        ],
      },
    ],
    sources: ['EL/ELM7xxx tabular product overview', 'Your 2022 diagram'],
  },
];

const BY_ID = new Map(TYPE_KEY_FAMILIES.map((f) => [f.id, f]));

export function getFamily(id: string | null | undefined): TKFamily | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Family whose prefix matches a pasted order code. */
export function detectFamily(input: string): TKFamily | null {
  return detectFamilyIn(TYPE_KEY_FAMILIES, input);
}

/** Family named first in the note's path or tags (for the initial pick). */
export function familyFromNote(notePath: string, tags: readonly string[] = []): TKFamily | null {
  return familyFromTextIn(TYPE_KEY_FAMILIES, `${notePath} ${tags.join(' ')}`);
}
