Serves your current Jira sprint as a board in the browser and stays up until you stop it — the same board `/sprint` opens, without starting a TUI.

    ayin sprint

It prints the URL, opens it, and holds the port. Ctrl+C stops serving. If an ayin session is already running in this directory it uses that session's board instead of starting a second server, and exits.

The board is live, not a snapshot: one column per status, one card per ticket, re-read from Jira on every request, so a reload shows what changed. Click a card and the ticket opens beside the board — status, type, priority, who filed it, the description, and every comment, fetched when you click rather than up front. The `+` under the comments posts to Jira **as you**, using the credential `/jira-auth` stored, and the comment appears only after Jira confirmed it.

**ask ayin** under the Jira comments starts a headless ayin on this directory for every message you send — one message, one run. It gets the ticket, the earlier turns and your question, searches the code, and answers in the ticket's own thread. Everything it says on the way arrives in the thread while it works, small and quiet; the answer lands last, larger, and folds if it is long. Threads are markdown at `~/.ayin-cli/sprint/chat/<KEY>.md`, one file per ticket, with each run's log beside them — kept outside your repo so they never land in a diff or a commit. Nothing in that half touches Jira, so it works on a read-only credential.

The **red X** in the bottom-right corner clears every ayin thread on every ticket — back to full defaults. It asks first and names what it does not touch: your Jira comments, your code and the run logs all stay.

There is no offline form of this page and there will not be: the cards fetch, the comment box writes to an external service, and a page of dead buttons is worse than a line saying why there is no page. A missing or expired credential renders as the page explaining that, which is where you are already looking — run `ayin` and `/jira-auth` once to fix it.

## Options

    --no-open   serve and print the URL, open no browser (over ssh)
    --help
