Turns on heavy log coverage for anything ayin builds while it is active — every feature written under `/logcover` gets thorough instrumentation, not the normal amount.

Reach for it right before a hard debugging session: turn it on, have the agent build or touch the suspect code, and the result carries enough logging to actually see what happened on the next run, instead of adding print statements by hand after the fact. It only affects new work built while it's on — it doesn't retroactively instrument existing code.

## Examples

    /logcover
    /logcover off
