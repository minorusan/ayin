Picks which model a corpus build (`ayin indulge`) runs on — a separate decision from `/model`, which picks who answers you in chat.

A build reads the whole repo across thousands of calls over hours; a chat turn is seconds. The operator legitimately wants them on different machines: the corpus on a hosted model for the window and reasoning, the interactive agent on the local card at no cost per token. Because a build is thousands of calls, the tier chosen here is the whole bill — a flagship and a cheap tier on the same corpus can differ by an order of magnitude. Run it bare for a two-row dialog (your card vs. a hosted model); an argument sets it directly. `/indulge-model off` reverts to following whatever `/model` is set to.

## Examples

    /indulge-model
    /indulge-model openai gpt-4.1
    /indulge-model off
