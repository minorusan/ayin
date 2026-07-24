#!/bin/zsh
# finder-invoke-ayin.sh — open Terminal in <folder> and launch ayin there.
# Invoked (one arg = one folder) by the "Invoke Ayin" Finder Quick Action; also runnable by hand.
#
# We shell out to AppleScript's `do script` (not `open -a Terminal`) because only `do script`
# can both cd AND run a command in the new window. The folder is passed to osascript as an argv
# item and quoted with `quoted form of`, so spaces / quotes in the path are safe.
set -eu

dir="${1:?usage: finder-invoke-ayin.sh <folder>}"

/usr/bin/osascript - "$dir" <<'APPLESCRIPT'
on run argv
	set p to item 1 of argv
	tell application "Terminal"
		activate
		-- new window at the folder, then ayin; the shell stays after ayin exits.
		do script "cd " & quoted form of p & " && ayin"
	end tell
end run
APPLESCRIPT
