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
| `vp pack`                         | Compile the server and SQL worker into `dist/`.           |
| `vp test`                         | Run the test suite. Many tests use `dist/`; pack first.   |
| `vp run dev`                      | Recompile the server on change. It does not rebuild data. |
| `vp run build`                    | Build the complete reference database and server.         |
| `vpx scripts/validate-offsets.ts` | Validate the curated Offsets in `data/offsets/`.          |
| `vp pm pack`                      | Create the npm tarball.                                   |

Some tests also need Python 3, `tar`, npm, and network access, because they verify the client inputs or install the packed tarball.

CI runs `vp check`, `vp pack`, and `vp test` on every pull request and on pushes to `main`, and checks the pull request title and the workflows. On pushes to `main`, a separate workflow runs the download, package install, search, interface import, release gate, and SQL tests on Ubuntu, macOS, and Windows with Node 24.15.0 and 26.

## Repository layout

```text
.
├── src/                 MCP server, tools, and shared schema
│   └── acquire/         Database download, cache, and updates
├── build/               Reference build pipeline (vp run build); main.ts is the entry
│   ├── sources/         Pinned input acquisition and verification
│   ├── client/          DBC import
│   ├── codex/           API codex import: functions, events, widgets, CVars
│   ├── interface/       Interface source import
│   ├── native/          Native Lua registration import
│   ├── world/           World Data import and export
│   ├── links/           Link stage: relations between records
│   ├── enums/           Link stage: enum values from AzerothCore headers
│   ├── reference/       Artifact, fidelity report, and provenance
│   └── shared/          Helpers used by several stages
├── data/                Curated inputs: Offsets JSON, client-input manifest, World Data proofs
├── scripts/             Offsets validation, release gates, acceptance, and publication
├── tests/               Vitest suites: build/, server/, release/; helpers/ and fixtures/
└── docs/                Guides
```

A folder's entry module is `index.ts`; import it by its full path (`./world/index.ts`). Within a file, code runs top to bottom: imports, constants and schemas, types, private helpers, exported functions, then any entry-point code.

## Compatibility rules

`acceptedSchemaMajor` in `src/schema.ts` and `wotlkSchemaMajor` in `package.json` must match. Each package major accepts exactly one database schema major. Changing it, or making a breaking change to a tool's parameters or output, needs a new package major; see [Release operations](releases.md#publish-a-version).
