Sets the session goal, shown above the chat and carried into every turn as context.

Without a goal, ayin derives one automatically from your first real prompt — one LLM call that distills the direction into a stable one-liner, meant as an anti-wander anchor for long sessions. `/goal <text>` overrides that at any point, useful when the conversation drifted from what you originally meant, or when the auto-derived line missed the point. Bare `/goal` shows the current one; `/goal clear` (or `/goal none`) removes it, and a new one will be derived from whatever you say next.

## Examples

    /goal migrate the reward service off the legacy queue
    /goal
    /goal clear
