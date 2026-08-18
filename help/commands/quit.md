Exits ayin, releasing the shared model authority first so another consumer on the same card isn't left waiting on a hold this session no longer needs. Aliased as `/q` and `/exit`.

Prefer this over just killing the terminal window: a clean quit gives back the GPU hold immediately, where a hard kill relies on the backend's grant expiring on its own. Ctrl+C does the same release via a signal handler, so either way is safe to use.

## Examples

    /quit
    /q
    /exit
