Forces a corpus lookup for exactly one prompt, without turning on `/embed` for the rest of the session.

Use it when a single question mid-session needs the corpus — a pivot to a different feature than the one your first prompt named — but you don't want every later turn paying for a lookup it doesn't need. The text after the command becomes the actual prompt sent to the agent; only the lookup is different from typing it plain. Requires a corpus (`ayin indulge`) and `/corpus` injection on to have anything to return.

## Examples

    /embedthis how does the retry queue handle a dead consumer?
