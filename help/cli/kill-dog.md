Silence every hound, now and after the next reboot.

`ayin kill dog` throws a switch that every hound honours: `~/.ayin-cli/hound.off`. While that file exists, an installed hound Stop hook exits 0 on its first line — before the staged diff, before git, before any model — so the end of a Claude Code turn costs nothing at all. `ayin watch` installs no new hound, and the watch daemon's five-minute self-heal stops putting one back, which is the part that made deleting the hook by hand useless.

It then does the housekeeping: ayin's own `ayin-hound.mjs` (and the older `ayin-hound.sh`) is removed from every repo ayin registered, plus the repo you are standing in, along with its entry in that repo's `.claude/settings.json` — only the entry naming our own script, never anything else in the file.

A hound ayin did not install is REPORTED, never touched. That is the usual reason `ayin unwatch` seemed not to work: a Stop hook someone added by hand is in no watch registry, so unwatch had nothing to remove. The command prints the command line it found and whether that script honours the switch; if it does not, it prints the one line to add at the top of it:

    [ -f "$HOME/.ayin-cli/hound.off" ] && exit 0

`ayin unwatch` remains the right command for ending a WATCH — reviews, hooks and registration for one repo. This one is about the dog alone, across every repo at once, including repos ayin has never heard of.

## Options

    --off, --revive   bring the dog back: delete the switch. Repos whose hound was removed get one
                      again when they are next watched.
    --status          say whether the dog is dead, and since when

## Examples

    ayin kill dog
    ayin kill dog --status
    ayin kill dog --off
