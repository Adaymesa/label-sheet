# Label sheet

Turns a pile of downloaded shipping labels into **one A4 page of barcodes** to hand over at
the post office counter, instead of opening and printing each label PDF one at a time.

It is a **single self-contained HTML file**. Open it, drag the label PDFs onto it, press
Print. No install, no terminal, no account, no network — the PDFs are read in the browser and
never uploaded anywhere.

```bash
npm install
npm run build      # -> dist/label-sheet.html
npm test           # 46 tests
npm run typecheck
```

## What it prints

Two columns, about 16 parcels per A4 page. Each row is the recipient's name, the destination
and weight, and a Code 128 barcode. Tracking numbers are hidden by default and can be turned
on from the toolbar — they are the only fallback if a scan fails at the counter.

Every barcode's SVG carries its own 10-module (5 mm) quiet zone, so two side-by-side symbols
keep 10 mm of clear space between them, as Code 128 requires. Bars are 0.5 mm per module and
16 mm tall — slightly larger than Correos itself prints (0.45 mm).

## Are the barcodes the same ones?

The barcodes are **regenerated**, not copied out of the PDF, so this question deserves a real
answer.

A Correos label encodes the bare S10 tracking number (`LX554474175ES`) as Code 128. That was
established by decoding the bar geometry directly out of a label PDF and checking the symbol
checksum, and `src/code128.test.ts` pins the encoder's output to those exact bar widths.

It was then checked the other way round, against the printed pixels: render each label at
600 dpi, read the bar widths off a scanline, decode them, and compare with what this project
generates for the same parcel. Across **106 real labels: 106/106 payloads matched, 0
mismatches.**

Of those, 55 were bar-for-bar identical and 51 were a *different but equivalent* encoding.
That is expected — Code 128 allows several encodings of the same string, and Correos' own
producers disagree with each other: the Exprés layout compresses digits with Code C, the CN22
layout does not. No single encoder can match both bar patterns. What is invariant, and what
was verified, is the decoded payload.

Two bugs were found this way and fixed:

- symbol value 99 is the "switch to Code C" instruction in code sets A and B, but the literal
  digits `99` inside Code C — so any tracking number containing `99` was misread
- labels drawn sideways on the page were read with their axes swapped, which put the sender's
  details on the sheet instead of the recipient's

## Supported label layouts

Four layouts appear in practice, differing in page rotation, structure and producer:

| Source | Shape | Tracking number |
| --- | --- | --- |
| Correos Exprés | landscape, `/Rotate 90` | in the file name *and* the page |
| Correos CN22 customs | landscape, customs table on the left | in the file name *and* the page |
| Sendcloud | portrait, upright text | page only — the file is `labels (52).pdf` |
| Sendcloud, rotated | portrait page, text drawn sideways | page only |

Rather than hard-coding coordinates per layout, `extractLabel.ts` keys off structure that
holds in all of them: the `TO` marker sits beside the recipient block, the block is a
left-aligned column (name first, country last), and phone numbers and delivery boilerplate
live in *other* columns — so clustering on the left edge separates them out.

Across a folder of 149 real labels, 144 are read cleanly and 5 are correctly refused.

## What it refuses to do

Labels that are not Correos S10 — a Sendcloud label from another carrier, say — are
**reported to the user, never guessed at**. A barcode that cannot be verified is not emitted:
a wrong barcode at the counter is worse than a missing one. The same applies when a file name
disagrees with the tracking number printed on the page.

## Structure

Pure domain in `src/`, IO only at the edges:

| File | Role |
| --- | --- |
| `code128.ts` | Code 128 encoder (+ a decoder used only by tests) |
| `barcodeSvg.ts` | symbol -> SVG sized in millimetres |
| `extractLabel.ts` | positioned text -> `Label`, or a reported failure |
| `types.ts` | domain types |
| `pdfText.ts` | **adapter** — the only module that knows pdf.js exists |
| `browser/main.ts` | composition root: drag-and-drop, rendering, print |

`extractLabel` is tested against JSON snapshots of positioned text rather than against
pdf.js, so the tests are fast and deterministic.

### A note on the fixtures

The fixtures in `tests/fixtures/` are captures of genuine shipments with **the names,
addresses and phone numbers replaced by invented ones**. Every coordinate, width and height
is exactly as captured, so they still exercise the real geometry of each layout. The source
PDFs are personal data and are not committed.

`npm run fixtures` regenerates them from PDFs placed in that folder.

## Development

```bash
npm test                              # unit tests
npm run typecheck
npm run build                         # single-file bundle
npx tsx scripts/checkCorpus.ts ~/Downloads   # smoke check against a real folder of labels
```

`checkCorpus` is a smoke check, not a test: it runs the real pipeline over a directory and
flags anything that looks mis-read — a name that is really a street line, a missing country,
a label it could not parse at all.
