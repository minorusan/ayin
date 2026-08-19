Build or query an overnight, per-repo corpus of verified answers about the codebase.

`ayin indulge --domains "<what you work on>"` runs a long, unattended job: it discovers the files touching each named domain, generates questions about them, and answers each one with a citation-verified pass over the real code, writing everything to `~/.ayin-cli/rag/<repo-key>/` outside the work tree so a corpus is never accidentally committed. Every stage flushes its result to disk as it goes and resumes from the last record on restart, so killing the process costs at most the one item in flight. `Ctrl+C` once asks it to finish the current record and stop cleanly; twice exits immediately. With no corpus yet, `ayin testrun` and `/corpus` fall back to weaker name matching and say so.

Building spends real model time against whichever provider `--provider` names or the interactive agent's default. Once built, `--status`, `--report`, `--search` and `--ask` are pure disk reads needing no reachable model. `--qa` audits existing answers (a free rules pass, then a paid model pass); `--fix` re-answers what the audit rejected and re-embeds only what changed, never deleting unproven work.

A corpus is a night of GPU, so it is normally built on the one machine with a card and USED everywhere
else. `ayin indulge --import --server <host:port>` fetches this repo's corpus from a machine serving
`GET /corpus` + `GET /corpus/<key>.tgz` and installs it through the same identity check a local
`--import` runs — a corpus built for another project is refused, not merged. The corpus key is derived
from the repo's identity, so no negotiation is needed: if the server has one for this repo, it is under
the same name. Vectors are deliberately left behind (they are only comparable to vectors from the same
embedding model); run `ayin indulge --embed` afterwards to rebuild them here, which is minutes of CPU.

## Options

    --domains "<a>,<b>"      comma-separated domains to build (required for a build)
    --repoPath <path>        repo to build against (default: cwd)
    --status                 what the running build is doing now, and how far along
    --report                 write the audit markdown and stop
    --dry-run                discover only — file list and question estimate, spends nothing
    --embed                  vectorise the corpus for semantic search (CPU only)
    --search "<q>"           ask the corpus what it knows, exactly as the agent would see it
    --provider <name>        build on a different LLM provider than the interactive agent
    --retry-failed           re-queue failed questions and answer them again
    --qa                     audit the corpus (rules pass, then a model pass)
    --qa-rules               the free rules pass only, no model
    --fix                    re-answer what the audit rejected, then re-embed what changed
    --import <dir>           install a corpus built elsewhere
    --server <host:port>     pull this repo's corpus from a corpus server and install it (with or
                             without --import). The key is identity-derived, so the corpus this repo
                             needs has the same name on the server; vectors are not shipped — re-run
                             --embed locally afterwards
    --deep                   full investigation per question, slower and more thorough
    --restart                discard the existing corpus and rebuild (default resumes)
    --depth <n>              reference-walk depth (default 3)
    --max-files <n>          cap discovered files per domain
    --max-questions <n>      cap answers processed this run
    --categories '["a","b"]' angles to ask about; five ship tuned, any other name still works

## Examples

    ayin indulge --domains "rendering,checkout" --depth 2
    ayin indulge --status
    ayin indulge --search "how does the reward service pick a winner"
    ayin indulge --import --server <host>:<port>
