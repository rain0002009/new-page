# Issue tracker: GitHub

Issues and specs live in GitHub Issues. Use the gh CLI.
Resolve the repository from git remote -v. The current repository is
`rain0002009/new-page`, configured as `origin`.

- Create: gh issue create --title "..." --body-file <file>
- Read: gh issue view <number> --comments
- List: gh issue list --state open
- Comment: gh issue comment <number> --body-file <file>
- Labels: gh issue edit <number> --add-label "..." --remove-label "..."
- Close: gh issue close <number>

PRs as a request surface: no.

When a skill says "publish to the issue tracker", create a GitHub issue.
When it says "fetch the relevant ticket", read the issue and its comments.
