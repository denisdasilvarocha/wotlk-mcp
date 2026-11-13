# Issue tracker: GitHub

Issues and specs live in `denisdasilvarocha/wotlk-mcp` on GitHub. Use the `gh` CLI from this clone.

## Conventions

- Before the first issue creation of a session, run `gh repo view --json nameWithOwner` and verify the target is `denisdasilvarocha/wotlk-mcp`. If it differs, resolve the target before writing; never file into the skills’ source repository.
- Create: `gh issue create --title "..." --body-file -` with a heredoc for multiline bodies.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`, adding label and state filters as needed.
- Sub-issues: `gh issue create --parent <parent> ...` or `gh issue edit <parent> --add-sub-issue <child>`. If unavailable, put `Part of #<parent>` at the top of the child body and add the child to the parent’s task list.
- Blocking: use native dependencies with `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>`. If unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- Count open native blockers: `gh api repos/denisdasilvarocha/wotlk-mcp/issues/<n> --jq .issue_dependencies_summary.blocked_by`.
- Comment: `gh issue comment <number> --body "..."`.
- Labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`. Use `docs/agents/triage-labels.md` for triage roles.
- Close: post the explanation with `gh issue comment`, then run `gh issue close <number>`. Separate commenting preserves the explanation even if the issue is already closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

When a skill says “publish to the issue tracker”, create a GitHub issue. When it says “fetch the relevant ticket”, read the issue.

## Wayfinding operations

- Map: a single issue labelled `wayfinder:map`, holding Notes / Decisions-so-far / Fog.
- Child ticket: link it to the map as a sub-issue, using the fallback above if needed. Label it `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`). Ensure a required label exists before using it.
- Frontier: inspect the map’s open children in map order; skip any assigned ticket or ticket with an open blocker. The first remaining ticket wins.
- Claim: `gh issue edit <n> --add-assignee @me`, the session’s first write.
- Resolve: comment with the answer, close the ticket, then append a gist and link to the map’s Decisions-so-far.
