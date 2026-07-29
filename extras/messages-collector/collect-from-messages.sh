#!/bin/bash
#
# Collects recent Correos label PDFs out of Messages into one folder, ready to drag
# onto the label sheet.
#
# Messages keeps every attachment as a real file on disk under
# ~/Library/Messages/Attachments, with its original download name intact, and indexes
# them in a SQLite database. So "the labels we sent each other" is a query, not a
# manual save-as of each one.
#
#   ./collect-from-messages.sh [days]     default: 7
#
# Reading the Messages database needs Full Disk Access. See the message below.

set -euo pipefail

DAYS="${1:-7}"
DB="$HOME/Library/Messages/chat.db"
OUT="$HOME/Downloads/Labels to print"

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "Days must be a whole number, got: $DAYS" >&2
  exit 2
fi

# Fail loudly and usefully: an unreadable database is almost always a missing
# permission rather than a missing file, and the fix is not discoverable.
if ! sqlite3 "$DB" 'select 1 from attachment limit 1;' >/dev/null 2>&1; then
  echo "Cannot read your Messages database." >&2
  echo >&2
  echo "Grant Full Disk Access to whatever is running this:" >&2
  echo "  System Settings > Privacy & Security > Full Disk Access > +" >&2
  echo >&2
  echo "Then run this again." >&2
  exit 1
fi

# Timestamps live on `message`, not on `attachment` -- attachment.created_date is 0 on
# every row here. Dates are nanoseconds since 2001-01-01, hence the offset. The cast
# matters: strftime returns text, and SQLite sorts every integer below every string, so
# without it the comparison is silently always false and you collect nothing.
sql="select a.filename
     from attachment a
     join message_attachment_join j on j.attachment_id = a.ROWID
     join message m on m.ROWID = j.message_id
     where a.mime_type = 'application/pdf'
       and m.date / 1000000000 + 978307200
           > cast(strftime('%s', 'now', '-$DAYS days') as integer)
     order by m.date desc;"

# Same rule scripts/checkCorpus.ts uses: a tracking-number name, or a Sendcloud
# "labels.pdf". Everything else in the thread is somebody's unrelated PDF.
is_label() {
  local n="$1"
  [[ "$n" == *_case* || "$n" == *_reembolso* || "$n" == *_factura* ]] && return 1
  [[ "$n" =~ ^[A-Z]{2}[0-9]{9}[A-Z]{2}\.pdf$ ]] && return 0
  [[ "$n" == labels* ]] && return 0
  return 1
}

mkdir -p "$OUT"

stale=$(find "$OUT" -maxdepth 1 -name '*.pdf' | wc -l | tr -d ' ')
if [ "$stale" -gt 0 ]; then
  echo "Clearing $stale PDF(s) from a previous run."
  find "$OUT" -maxdepth 1 -name '*.pdf' -delete
fi

copied=0
skipped=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  path="${f/#\~/$HOME}"
  [ -f "$path" ] || continue

  name="$(basename "$path")"
  if ! is_label "$name"; then
    skipped=$((skipped + 1))
    continue
  fi

  # The same label sent twice lands here twice. Keep both rather than guessing which
  # copy is current -- the sheet drops duplicate tracking numbers by itself.
  dest="$OUT/$name"
  n=1
  while [ -e "$dest" ]; do
    dest="$OUT/${name%.pdf} ($n).pdf"
    n=$((n + 1))
  done

  cp "$path" "$dest"
  copied=$((copied + 1))
done < <(sqlite3 "$DB" "$sql")

echo "Collected $copied label(s) from the last $DAYS days into:"
echo "  $OUT"
[ "$skipped" -gt 0 ] && echo "Ignored $skipped PDF(s) that were not labels."

exit 0
