Sets where a run you send to the background with Ctrl+B does its thinking. Nothing else changes provider — this agent and its subagents keep whatever they already use.

With no argument it opens a dialog: provider, then tier. The model list comes from your own account, so it cannot offer an id that no longer exists.

## Why this setting exists

A self-hosted model is one **queue**, not a lock. Two callers do not run at the same time, they take turns. So detaching a long task from the turn hands back your prompt and nothing else: the moment you type, your round is behind that task's next generation, and every round after it too. Backgrounding on one card moves the wait; it does not remove it.

Pointing backgrounded runs at an endpoint with its own capacity is what makes the second lane real. That is the whole setting.

## Unset is a working state

With nothing set, Ctrl+B still detaches a run and says it stayed on this model. That is deliberate: pressing a key to unblock yourself must never be the thing that starts spending money.

## Providers

`openai` and `ollama` only. `direct` and `resource` are refused rather than stored — both point at the endpoint the foreground already uses, so a lane on either would queue behind the very turn it was meant to unblock, and a setting that silently does nothing is worse than no setting.

## Cost

A backgrounded run on a hosted model bills per token for as long as it runs, unattended, while you are doing something else. Pick the tier with that in mind; the dialog says what each one is for and what it costs.

## Examples

    /set-background-model                          the dialog
    /set-background-model openai                   that provider's default model
    /set-background-model openai gpt-5.6-sol       a specific tier
    /set-background-model off                      detach only, no second lane
