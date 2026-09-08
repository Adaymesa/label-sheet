# Correos label sheet

Drag your **Correos** shipping labels onto a page, get **one A4 sheet with every barcode on
it**, and hand that over at the counter — instead of opening and printing each label PDF one
at a time.

![The app with six parcels loaded, showing the printable sheet preview](docs/screenshot.jpg)

**→ [label-sheet.vercel.app](https://label-sheet.vercel.app)** — or open `dist/label-sheet.html`
straight off disk; they are the same file.

Drop the PDFs on, press **Print**. Nothing to install, no terminal, no account, no sign-up.
Hosted or local makes no difference to your data: the page is static, the PDFs are read in
your browser, and nothing is ever uploaded.

> Built for **Correos (Spain)** labels specifically — Correos Exprés, CN22 customs, Paq
> Estándar, and the Correos labels produced by Sendcloud. It is not a general-purpose
> shipping-label tool and will not understand labels from other carriers.

## Using it

1. Download your labels as usual — they land in your Downloads folder.
2. Open [label-sheet.vercel.app](https://label-sheet.vercel.app).
3. Select the lot and drag them onto the page (or click to pick them). Dropping everything
   is the point — you do not have to work out which ones you still need.
4. Pick the days you are posting, click out anything you are not, then press **Print**.

## Loading from a folder

Instead of picking files out of Downloads every time, point the app at the folder once:
**Load from a folder…**. After that it remembers, and every visit just asks the one
question that matters — **This week** or **Everything**.

**This week** filters on the folder listing, before a single PDF is opened. A folder of two
hundred labels opens the ten from this week, which is why it is instant no matter how full
Downloads gets. **Everything** reads the lot and widens the days on offer to match, so
nothing is loaded and then hidden.

> **Chrome will not hand over the Downloads folder itself.** It sits on the browser's
> blocklist beside your home folder, Desktop and Documents. A folder *inside* Downloads is
> allowed, so make `Downloads/labels` and point Chrome's download location at it — or pick
> any other folder you like. The app says so plainly if the browser refuses.

Two more things worth knowing. The folder is remembered but permission to read it is not,
so the browser asks again now and then; choosing **Allow on every visit** stops it asking.
And this needs the hosted page — the File System Access API does not exist on `file://`, so
`dist/label-sheet.html` opened off disk shows drag-and-drop only.

Everything else still works exactly as before: drag files on whenever you like, folder or
no folder.

## Days, parcels, and what has been printed

The app sorts the pile into the days the labels were made on and offers those days as
buttons — **Today**, **Saturday 5 Sep** — with a count on each. The days come from your
labels, so a day is never offered empty and never missing. Anything older than a week is
left out; those labels are still in Downloads, they are just not what today's post office
run is about.

Today's batch is on when you drop the files, because that is usually the run. Clicking
another day adds all of it.

Then **click a parcel to leave it out**, and click it again to put it back. The card itself
is the control — there is no separate tick to hit and no cross to press — so it dims and its
mark empties, and it stays where it is. Clicking the day off and on resets the whole day.

Nothing on this page destroys anything. Every part of it is the same gesture: click a thing
to turn it off, click again to turn it on. **Start over** is the only way to clear the sheet.

The button counts what will actually come out — `Print 9 labels` — which is the last thing
worth reading before you commit paper to it.

A parcel you have printed before is marked **printed today** / **printed Friday 4 Sep**. It
stays on: a torn sticker or a jam means printing one again is normal, so the mark warns
you and never decides for you. That record lives in this browser only. If it is ever
cleared the marks disappear and nothing else changes — the failure costs a hint, never a
parcel.

Each row shows who the parcel is for, where it is going and what it weighs, with the barcode
and its tracking number underneath. International parcels also carry a tag saying whether
the CN22 declares them a **gift** or **merchandise**, so the two are easy to tell apart at
the counter. Two columns, about 16 parcels per A4 page, so 25 labels come out as 2 pages
rather than 25.

Anything it cannot read confidently is listed separately with the reason, so you know to
print that one the old way. It will never put a barcode on the sheet it could not verify.

**Tracking numbers** are printed under each barcode, because they are the only fallback if
the counter's scanner is having a bad day. There is a toggle in the toolbar to hide them.

`extras/messages-collector/` is an optional helper for our own workflow — we send labels to
each other in iMessage, and it pulls the recent ones into a folder to drag on. It is not part
of the app and you almost certainly do not want it.

## Building it

```bash
npm install
npm run build       # -> dist/label-sheet.html
npm test            # 126 tests
npm run typecheck
```

## Which labels work

| Label | Where it comes from | Barcode contains |
| --- | --- | --- |
| Correos Exprés | Mi Oficina | S10 tracking number (`LX554474175ES`) |
| Correos CN22 customs | Mi Oficina, international | S10 tracking number |
| Paq Estándar | Correos premium | parcel code (`Código de Bulto`) |
| Sendcloud | Sendcloud, upright or sideways | S10 tracking number |

Recipient names in any script are handled, including Japanese and Chinese.

Across a folder of 195 real labels, 194 are read correctly and 1 is correctly refused (an
address sheet with no barcode on it at all). Of those, 114 carry a CN22 category, split 75
gift and 39 merchandise.

## Are the regenerated barcodes really the same?

The barcodes are drawn fresh rather than copied out of the PDF, so this is worth being sure
about. It was checked against the printed pixels: render each label at 600 dpi, read the bar
widths off a scanline, decode them, and compare with what this project produces for the same
parcel. **110 real labels, 110 payloads matched, 0 mismatches.**

Some come out bar-for-bar identical and some as a different-but-equivalent encoding, because
Code 128 allows several encodings of one string and Correos' own label generators disagree
with each other. The decoded value — the thing a scanner reads — is always the same.

## How it works

`extractLabel` does not hard-code coordinates per layout. It keys off structure that holds
across all of them: a `TO` / `Destinatario` marker sits beside the recipient block, the block
is a left-aligned column with the name first and the country last, and phone numbers and
delivery boilerplate live in other columns — so grouping by left edge separates them out.

Pure domain logic in `src/`, IO only at the edges:

| File | Role |
| --- | --- |
| `code128.ts` | Code 128 encoder (and a decoder used only by tests) |
| `barcodeSvg.ts` | symbol → SVG, sized in millimetres |
| `extractLabel.ts` | positioned text → a label, or a reported failure |
| `queue.ts` | labels → the days on offer, and which parcels a selection means |
| `folderLoad.ts` | a folder listing → the files worth opening |
| `printed.ts` | the print record: marking, reading, and forgetting old entries |
| `types.ts` | domain types |
| `pdfText.ts` | adapter — the only file that knows pdf.js exists |
| `browser/folderAccess.ts` | adapter — the only file that knows the File System Access API |
| `browser/folderStore.ts` | adapter — the only file that knows the folder is in IndexedDB |
| `browser/printedStore.ts` | adapter — the only file that knows the record is stored |
| `browser/main.ts` | wiring: drag-and-drop, rendering, print |

`queue.ts` and `printed.ts` know nothing about each other. That is deliberate: the print
record annotates a row and never filters one, so losing it cannot change what comes out of
the printer.

Barcodes are 0.5 mm per module and 16 mm tall, each carrying its own 5 mm quiet zone, so
side-by-side symbols keep 10 mm of clear space as Code 128 requires.

## Development

```bash
npm test
npm run test:watch
npx tsx scripts/checkCorpus.ts ~/Downloads   # run the real pipeline over a folder of labels
```

`checkCorpus` is a smoke check rather than a test: it runs everything over a real directory
and flags whatever looks mis-read — a name that is really a street line, a missing country, a
label it could not parse.

### Fixtures

`tests/fixtures/*.json` are captures of real shipments with **names, addresses and phone
numbers replaced by invented ones**. Coordinates are untouched, so they still exercise the
real geometry of each layout. The source PDFs are personal data and are not committed;
`npm run fixtures` captures any PDF in that folder that has no JSON yet.

It will not overwrite an existing capture unless you pass `--force`, because the PDFs are
real and the JSON beside them is not: regenerating in place silently swaps invented names
back for real customer ones, in a public repository. If you do force it, re-anonymise.

### One gotcha worth knowing

The build refuses to emit any non-ASCII character. The app ships as a single HTML file with
no charset declaration, so a raw UTF-8 byte gets misread when the file is opened from disk —
which once silently broke a regex containing `ó` and made Paq labels unrecognisable. Write
non-ASCII as `\uXXXX` escapes in the source.
