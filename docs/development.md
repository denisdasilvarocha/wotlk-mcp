# Development

Set up the repository to change the server, the build pipeline, or the curated data. To use the server, see the [README](../README.md#install) instead.

## Set up

You need Node.js 24.15.0 or newer and [Vite+](https://viteplus.dev/guide/) (`vp` and `vpx`). Install dependencies and the Git hooks from the repository root:

```sh
vp install
```

The pre-commit hook runs `vp check --fix` on staged files.

To run the server, you also need a reference database. Build one with `vp run build`; see [Build the reference](build.md).

## Commands

| Command                           | Purpose                                                   |
| --------------------------------- | --------------------------------------------------------- |
| `vp check`                        | Format, lint, and type-check.                             |
| `vp test`                         | Run the test suite.                                       |
| `vp pack`                         | Compile the server and SQL worker into `dist/`.           |
| `vp run dev`                      | Recompile the server on change. It does not rebuild data. |
| `vp run build`                    | Build the complete reference database and server.         |
| `vpx scripts/validate-offsets.ts` | Validate the curated Offsets in `data/offsets/`.          |
| `vp pm pack`                      | Create the npm tarball.                                   |

Some tests also need Python 3, `tar`, npm, and network access, because they verify the client inputs or install the packed tarball.

CI runs `vp check`, `vp test`, and `vp pack` on every pull request and on pushes to `main`. On pushes to `main`, a separate workflow runs the download, package install, search, interface import, release gate, and SQL tests on Ubuntu, macOS, and Windows with Node 24.15.0 and 26.

## Repository layout

```text
.
├── src/       MCP server, tools, database download, and shared schema
├── build/     Reference build pipeline (vp run build)
├── data/      Curated inputs: Offsets JSON, client-input manifest, World Data proofs
├── scripts/   Offsets validation, release gates, acceptance, and publication
├── tests/     Vitest suites and fixtures
└── docs/      Guides
```

## Compatibility rules

`acceptedSchemaMajor` in `src/schema.ts` and `wotlkSchemaMajor` in `package.json` must match. Each package major accepts exactly one database schema major. Changing it, or making a breaking change to a tool's parameters or output, needs a new package major; see [Release operations](releases.md#publish-a-version).
