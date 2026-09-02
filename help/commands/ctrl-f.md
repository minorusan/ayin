Folds every tool card in the transcript to five lines. Press it again to unfold them.

Folding is **on by default**. A card is a summary, not the output — a long one pushes the answer you were reading off the screen, and the tools that produce the longest cards (a plan's phase breakdown, a `write_file` diff) are the ones you least often need in full while the turn is still running.

Nothing is hidden that is not still saved. The full output of every tool run is kept as an artifact — Ctrl+O opens it — so the fold is a display choice and the marker on a folded card says how many lines it stands for.

## Unfolded is not "everything"

Unfolding restores each card's own preview budget, which differs per tool: `bash` and `grep` show six lines, `read_file` four, a plan card up to twenty, a diff thirty-four. That budget is what the card was already doing before this key existed. For the genuinely complete output, Ctrl+O is still the way.

## It applies to the whole transcript, at once

The fold is computed while the screen is painted, not when a card is built, so pressing it changes every card already on screen as well as every card after it. Scroll position is kept.

It works while the agent has the terminal, like Ctrl+B and Ctrl+O.

## Examples

    Ctrl+F      a 20-line plan card is in the way → five lines and a marker
    Ctrl+F      again → the cards go back to their own budgets
    Ctrl+O      the full output, always, folded or not
