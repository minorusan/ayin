Quits ayin immediately — a global handler, not routed through the input box, so it works no matter what has focus.

Unlike Esc, which is layered (close an overlay, then cancel a shell command, then interrupt the agent, and only then touch your typed text), Ctrl+C goes straight to shutdown. The shared model authority is still released on the way out via the same signal handler `/quit` uses, so another consumer on the card isn't left waiting on a stale hold.

## Examples

    Ctrl+C
