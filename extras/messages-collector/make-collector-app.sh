#!/bin/bash
#
# Builds "Collect labels.app" -- a double-clickable wrapper around
# collect-from-messages.sh, for someone who should never have to see a terminal.
#
# The shell script is copied into the app bundle rather than referenced, so the app can
# be handed to another Mac on its own. collect-from-messages.sh stays the only copy of
# the logic.
#
#   ./make-collector-app.sh     ->  dist/Collect labels.app

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
app="$root/dist/Collect labels.app"

mkdir -p "$root/dist"
rm -rf "$app"

# The wrapper reads the script out of its own bundle, so it has no idea where the
# repository is -- or whether one exists on this Mac at all.
osacompile -o "$app" - <<'APPLESCRIPT'
on run
    set scriptPath to POSIX path of (path to resource "collect-from-messages.sh")
    set folder_ to (POSIX path of (path to home folder)) & "Downloads/Labels to print"

    try
        set output to do shell script quoted form of scriptPath & " 7"
    on error errMsg
        display dialog errMsg with title "Collect labels" buttons {"OK"} ¬
            default button "OK" with icon caution
        return
    end try

    display dialog output with title "Collect labels" buttons {"Open the folder"} ¬
        default button "Open the folder" with icon note
    do shell script "open " & quoted form of folder_
end run
APPLESCRIPT

cp "$here/collect-from-messages.sh" "$app/Contents/Resources/collect-from-messages.sh"
chmod +x "$app/Contents/Resources/collect-from-messages.sh"

echo "Built: $app"
