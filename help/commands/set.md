Persists a setting to ayin's config file, keyed in kebab-case (translated internally to the camelCase the code actually reads).

Useful for anything you'd otherwise pass as an environment variable every launch — `/set llm-url <url>` is the common one, so you stop typing `AYIN_LLM_URL` by hand. If the key doesn't match anything ayin actually reads, it still gets stored (you may know something this build doesn't) but the response says plainly that nothing consumes it, rather than pretending the setting took effect. `openai-key` is refused outright and redirected to `/openai`, which verifies the key before saving it; `default-model` is refused because nothing applies it any more.

## Examples

    /set llm-url http://localhost:9100
    /set terminal-command "wt.exe {{SCRIPT}}"
