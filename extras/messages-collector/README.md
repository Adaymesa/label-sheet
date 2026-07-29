# Messages collector

**This is specific to how we work, and probably useless to anyone else.** It is not part of
the label sheet. The app itself never needs it — you can always just drag PDFs on by hand.

We send shipping labels to each other in iMessage. This pulls the recent ones out of that
thread and drops them in a folder, so nobody has to save 20 attachments one at a time.

If that is not your workflow, ignore this folder entirely.

## Why it cannot be a button in the app

The label sheet is a web page, and a web page cannot read your Messages database — no file
access, no SQLite, and macOS gates the whole thing behind Full Disk Access anyway. So this
part has to be a small native thing that runs outside the browser.

## Using it

```bash
./collect-from-messages.sh          # last 7 days
./collect-from-messages.sh 14       # last 14 days
```

Labels land in `~/Downloads/Labels to print`. Drag them onto the sheet as usual.

For someone who should never see a terminal, build the double-clickable version:

```bash
./make-collector-app.sh             # -> dist/Collect labels.app
```

Double-click it, and it collects, reports how many it found, and opens the folder. Keep it
in the Dock. The script is copied inside the bundle, so the app works on a Mac that has no
copy of this repository.

## Full Disk Access

Reading Messages needs it, and it is worth being deliberate about: **it lets that app read
everything on the Mac, including every message and photo.** Granting it to a homemade script
is a real decision, not a checkbox.

System Settings → Privacy & Security → Full Disk Access → **+** → pick `Collect labels.app`.

Without it the script exits with an explanation rather than an obscure SQLite error.

## What it actually does

Messages keeps every attachment as a real file under `~/Library/Messages/Attachments/`, with
its original download name intact, and indexes them in `~/Library/Messages/chat.db`. That is
the whole trick: the filenames survive, so a label sent in iMessage is still recognisably
`LX554474175ES.pdf`.

Two things that are easy to get wrong here:

- `attachment.created_date` is **0 on every row**, so the timestamp has to come from the
  joined `message` row instead.
- `strftime` returns text, and SQLite sorts every integer below every string. Comparing a
  date against it without a cast is silently always false, and you collect nothing.

Only label-shaped filenames are copied — a tracking number, or a Sendcloud `labels.pdf`.
This is the same rule `scripts/checkCorpus.ts` uses. Everything else in the thread stays put.

Duplicates are kept rather than guessed at; the sheet drops repeated tracking numbers by
itself.
