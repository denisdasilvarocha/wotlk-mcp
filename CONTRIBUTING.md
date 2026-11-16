# Contributing to wotlk-mcp

Thanks for helping. This guide covers what you need to land a change. [Development](docs/development.md) covers the layout and compatibility rules.

## Setup

You need Node.js 24.15.0 or newer and [Vite+](https://viteplus.dev/guide/). From the repository root:

```sh
vp install
```

## Develop

| Task                              | Command    |
| --------------------------------- | ---------- |
| Format check, lint, and typecheck | `vp check` |
| Build the server into `dist/`     | `vp pack`  |
| Test (needs `dist/`)              | `vp test`  |

CI runs these commands in this order; a pull request merges only when they pass.

## Pull requests

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Branch from `main` and keep each pull request to one change.
3. Title the pull request with [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) (`feat(search): add kind filter`, `fix(acquire): use asset url`). Pull requests are squash-merged, so the title becomes the commit message and the release notes entry.
4. Add or update tests for behaviour changes.

## Reporting bugs and security issues

Use the issue forms for bugs and feature requests. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

By contributing, you agree that your contributions are licensed under the project's license and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
