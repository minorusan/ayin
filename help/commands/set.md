Persists a setting to ayin's config file, keyed in kebab-case (translated internally to the camelCase the code actually reads).

Useful for anything you'd otherwise pass as an environment variable every launch — `/set llm-url <url>` is the common one, so you stop typing `AYIN_LLM_URL` by hand. If the key doesn't match anything ayin actually reads, it still gets stored (you may know something this build doesn't) but the response says plainly that nothing consumes it, rather than pretending the setting took effect. `openai-key` is refused outright and redirected to `/openai`, which verifies the key before saving it; `default-model` is refused because nothing applies it any more.

`embed-url` is worth knowing about: embeddings normally go to the same endpoint as everything else (one door), and this is how you point them somewhere else on purpose — a small embedding model running locally while generation goes to a bigger box. Unset means one door. Changing `embed-model` invalidates every vector in a corpus, because a vector is only comparable to vectors from the same model, so it means re-embedding.

## Examples

    /set llm-url http://localhost:9100
    /set embed-url http://127.0.0.1:11434
    /set embed-model nomic-embed-text
    /set terminal-command "wt.exe {{SCRIPT}}"
