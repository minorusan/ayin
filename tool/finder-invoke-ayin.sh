#!/bin/zsh
# finder-invoke-ayin.sh — open a terminal in <folder> and launch ayin there.
# Invoked (one arg = one folder) by the "Open Ayin here" Finder Quick Action; also runnable by hand.
#
# Terminal choice: AYIN_TERMINAL=ghostty|terminal, else auto (Ghostty if installed, else Terminal).
#   Ghostty: `open -na Ghostty --args --working-directory=<dir> -e <login shell> ayin`. -e runs the
#            command directly (no login shell), so we wrap in `zsh -lc` to get PATH (ayin on it), and
#            `exec zsh -il` after ayin so the window stays open like a normal shell.
#   Terminal: AppleScript `do script` (cd + ayin); the folder is quoted via `quoted form of`.
set -eu

dir="${1:?usage: finder-invoke-ayin.sh <folder>}"
term="${AYIN_TERMINAL:-auto}"
[ "$term" = auto ] && { [ -d /Applications/Ghostty.app ] && term=ghostty || term=terminal; }

if [ "$term" = ghostty ]; then
  open -na Ghostty --args --working-directory="$dir" -e /bin/zsh -lc "ayin; exec /bin/zsh -il"
else
  /usr/bin/osascript - "$dir" <<'APPLESCRIPT'
on run argv
	set p to item 1 of argv
	tell application "Terminal"
		activate
		do script "cd " & quoted form of p & " && ayin"
	end tell
end run
APPLESCRIPT
fi
