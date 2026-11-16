# wotlk-mcp

Read-only MCP server for World of Warcraft 3.3.5a build 12340. `src/` is the server, `build/` the pipeline that builds the reference SQLite database, `data/` curated inputs, `scripts/` release tooling. Explicit user instructions take precedence over this file.

## Commands

Run from the repository root. The toolchain is Vite+ (`vp`, `vpx`); do not use `npm`, `pnpm`, `tsx`, or `ts-node`.

```sh
vp install                          # install deps and git hooks; run after pulling
vp test tests/sql.test.ts           # run one test file (prefer this)
vp test                             # full suite, ~30 s; run vp pack first; some tests need network, Python 3, tar, npm
vp check                            # format check, lint, type-check (CI gate)
vp check --fix                      # same, and fixes formatting; modifies files
vp pack                             # compile src/ into dist/
vpx scripts/validate-offsets.ts     # validate data/offsets/*.json
vp run build ./output-next          # full database build; slow, needs Docker, gh auth, several GB
```

## Workflow

1. After each change, run the focused test for the touched area.
2. Before reporting done, run `vp check`, `vp pack`, and `vp test`, in that order; CI runs exactly these three, and tests use `dist/`.
3. After editing `data/offsets/`, run `vpx scripts/validate-offsets.ts`.

## Gotchas

- Use `vp run build`, not `vp build`: the built-in `vp build` is Vite's build, not the `package.json` script.
- `vp run build` refuses an existing destination, and `output/` usually exists. Pass a new directory, e.g. `vp run build ./output-next`. Builds cannot resume; build into a fresh directory after a failure.
- Run TypeScript files with `vpx <file>`, not `node`.
- `data/offsets.schema.json` is generated from the Zod schema in `build/offsets.ts`. After changing that schema, run `vpx scripts/validate-offsets.ts --schema > data/offsets.schema.json`.
- The pre-commit hook runs `vp check --fix` on staged files and can rewrite them.

## Invariants

- `acceptedSchemaMajor` in `src/schema.ts` must equal `wotlkSchemaMajor` in `package.json`. Changing it, or making a breaking change to a tool's parameters or output, requires a new package major: mark the PR title breaking (`feat!: ...`) so release-please cuts it.
- When a build stage fails on a schema, layout, hash, or provenance check, fix the cause; do not relax validation, skip a domain, or drop source data to get past it.
- Links come only from stored keys, never from names or text; source rows are stored exactly. See the interpretation rules in `docs/build.md`.

## Boundaries

- **Ask first:** adding dependencies; changing `vite.config.ts` lint rules or CI workflows; bumping the schema major.
- **Never:** create, edit, or delete GitHub releases or tags, merge a release-please PR (`chore(main): release ...`), or run `npm publish`; releases are immutable and need owner authorization (`docs/releases.md`). Prepare the change and hand it to the user.

## Commits

- Conventional Commits with a scope: `fix(acquire): use asset url`, `refactor(build): share sqlite helpers`.

## References

- `docs/build.md`: read before changing `build/` or `data/`.
- `docs/releases.md`: read before touching `scripts/`, `.github/workflows/`, or versioning.
- `docs/tools.md`: read before changing tool parameters or output in `src/`.
- `docs/database.md`: read before changing database download, caching, or updates in `src/`.
