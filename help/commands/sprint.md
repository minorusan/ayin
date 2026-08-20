Opens your current Jira sprint as a board in the browser — one column per status, one card per ticket.

Click a card and the ticket opens beside the board: status, type, priority, who filed it, the full description, and every comment. That detail is fetched when you click, not up front — a sprint of twenty tickets would otherwise cost twenty requests and a minute of waiting for the nineteen you did not open.

The comments section has a `+`. It opens a box, and `post to Jira` posts what you typed to that ticket **as you** — the same credential `/jira-auth` stored. The comment appears in the list only after Jira confirmed it, so what you see on the page is what is on the ticket.

The board is served by the session you ran it from and re-read on every request, so a reload shows what changed. There is no offline copy: the cards fetch their own detail and the comment box writes to an external service, and a page with two dead buttons is worse than a page that says why it is not there.

Under the Jira comments there is **ask ayin**: a discussion about that ticket with the agent in your session. It gets the ticket, your question, and the path to the ticket's own thread file — then it searches the codebase and writes its answer back into that file, which the page picks up and shows. The thread is markdown at `~/.ayin-cli/sprint/chat/<KEY>.md`, one file per ticket, kept outside your repo so it never lands in a diff or a commit. It is separate from `post to Jira`: nothing here reaches Jira, so it works even on a read-only credential. While it is working you get a live row under the box saying what it is doing and for how long — `tool · Running grep(...)` — rather than a spinner that looks the same after four seconds and four minutes. It disappears when the answer lands.

Every card has a **link** button beside its ticket key, and the open ticket has one too — it copies `https://<your-site>/browse/<KEY>` to the clipboard, ready to paste into Slack or a commit message. It only appears when a Jira credential is configured, since there is no site to build a link from otherwise. Clicking it does not open the ticket.

## Examples

    /sprint
