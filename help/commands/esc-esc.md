Clears whatever you've typed into the input box — but only on a second Escape pressed within about 600ms of the first, and only when the first Escape had nothing else to close, cancel, or interrupt (see Esc).

The double-press requirement exists so a single stray Escape — the single most likely keystroke to hit by accident in a terminal — can never wipe out a prompt that took a minute to type. One press with nothing else to do is remembered; a second one that arrives fast enough turns into the clear. Wait too long between presses and the first is forgotten, so it takes two deliberate, close-together taps.

## Examples

    Esc Esc
