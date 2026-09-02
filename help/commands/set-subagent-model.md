What a SUBAGENT runs on — a different decision from `/model`.

    /set-subagent-model openai gpt-5.5   children run on that; this agent is unchanged
    /set-subagent-model openai           that provider's default model
    /set-subagent-model                  say what is set now
    /set-subagent-model off              children follow the agent again (the default)

Providers: `openai`, `ollama`, `resource`, `direct`.

## Why it is separate

The arbiter reads reports and picks the next phase. A child writes the code. Those are not the same
job and they do not want the same model: the card in the room arbitrates perfectly well and costs
nothing per token, while the implementation is the part worth paying a hosted model for.

Until this existed a child inherited the parent's environment wholesale, so the two were locked
together — pay flagship rates to arbitrate, or implement on whatever happened to be resident. The
combination this exists for is `ayin --arbiter` on your own card with `/set-subagent-model openai`
underneath it.

**With `openai`, every child costs money per token.** A five-phase build is five children, each with
its own context and its own budget. Nothing is escalated to it automatically — a local endpoint that
is merely unreachable still falls back to `direct`, never to a paid provider — but a phase that loops
is a phase that bills.

`direct` and `resource` take no model argument: their model is the endpoint's or the active preset's
to decide, and this command will not tell the resource layer what belongs on a card it does not own.

## Stored, not per-session

Like `/indulge-model`. A subagent runs unattended, often from a headless parent in another terminal,
and a setting that died with the session would silently not apply to the run it was set for.
