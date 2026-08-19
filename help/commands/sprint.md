Opens your current Jira sprint as a board in the browser — one column per status, one card per ticket.

Click a card and the ticket opens beside the board: status, type, priority, who filed it, the full description, and every comment. That detail is fetched when you click, not up front — a sprint of twenty tickets would otherwise cost twenty requests and a minute of waiting for the nineteen you did not open.

The comments section has a `+`. It opens a box, and `post to Jira` posts what you typed to that ticket **as you** — the same credential `/jira-auth` stored. The comment appears in the list only after Jira confirmed it, so what you see on the page is what is on the ticket.

The board is served by the session you ran it from and re-read on every request, so a reload shows what changed. There is no offline copy: the cards fetch their own detail and the comment box writes to an external service, and a page with two dead buttons is worse than a page that says why it is not there.

## Examples

    /sprint
