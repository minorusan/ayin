`read_files` reads a SET of files in one call. It is the tool ayin reaches for first when a question spans more than one file — the module, the type it imports, the test that pins it — and `read_file` is what you use for one file, or for a window of one.

The system prompt tells the agent to batch its reads, so this is the normal path, not an optimisation you have to ask for.

## One budget, split by length

The whole reply shares a single line budget rather than granting each file its own. That is the reason to call it at all: four `read_file` calls are four LLM rounds, and by the fourth the first file has been compressed out of the window it was read into.

The split is **proportional to length, with a floor**. Every file is guaranteed at least 40 lines so nothing comes back as a title and three lines; what remains goes to the files that still need it, repeatedly, so a file that fits whole costs only what it is and the long file absorbs the rest.

Measured on four files of this repo under a 400-line budget:

    4 file(s), 374 of 400 budgeted lines
    ── src/tools/defs/read_files.ts   lines 1-58 of 196
    ── src/full-mode.ts               all 28 lines
    ── src/diff/render.ts             lines 1-240 of 1716
    ── src/ui/keys.ts                 lines 1-48 of 138

The 1716-line file took the largest share; the 28-line file came back whole and cost 28.

## The budget is the model's context

There is no fixed line cap any more, for this tool or for `read_file`. Both ask `readCap()`, which reads the served model's context window and spends a quarter of it at eight tokens per line — deliberately pessimistic, because being wrong in that direction costs one extra call and being wrong the other way costs the turn.

    self-hosted, 16k window (or unknown)   800 lines
    gpt-5.6-luna, 1,000,000 window      31,250 lines

A model with no published window is UNKNOWN, not assumed, and gets the 800-line floor. Switching model with `/model` changes the cap on the next call — nothing is cached.

## What it will not do

- **Images and PDFs are skipped**, with a line saying so. An image attaches to the *next* LLM call, so a bulk read would attach ten of them to one request.
- **No corpus injection.** `read_file` shows what indulge already knows about a file; one such block per file would be the payload again, on a call whose whole purpose is to fit several files in one budget.
- **No sliding window, no `around`.** A set read is orientation. A window is the follow-up, and `read_file` is the follow-up tool.

At most 12 paths. Past that it is a directory listing — narrow with `grep` or `list_dir` first.

## Examples

    read_files paths=/abs/a.ts,/abs/b.ts,/abs/c.ts
    read_files paths=/abs/a.ts,/abs/b.ts limit=300     # a tighter budget than the model allows
    read_file  path=/abs/big.ts around=4012            # the follow-up, on one file
