    ayin chore                     the last 10 commits, as text
    ayin chore --commits 25        look further back
    ayin chore --all               include the used, and the reflection-invoked
    ayin chore --html              also write the page and open it
    ayin chore --html --no-open    write the page, print its path

Members — methods, properties, fields — added in recent commits that nothing in the tree uses, each with the commit that introduced it. See `ayin --help chore` for what the scan does and does not claim; `/chore` is the same report inside a session, which also opens the page.

Exit status is 0 whether or not anything was found: this is a report, and a non-zero exit would break any pipeline that runs it routinely. The counts are on stdout for anything that wants to decide for itself.
