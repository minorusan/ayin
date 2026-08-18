Drops the entangle constraint for this session, so the agent's writes stop being checked against a bound design file.

`entangle` is a tool the agent itself calls to bind a session to a design (the design file then becomes read-only to the agent — a write to it would just be a way to legalize its own violation, which is why the tool doesn't allow that either). Releasing that binding is deliberately left to the operator rather than the model: given the affordance to disentangle itself, a model reached for it to get past its own gate. `/disentangle` is that operator-only release. It is a no-op, and says so, if nothing is entangled.

## Examples

    /disentangle
