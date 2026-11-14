# wotlk-mcp

A read-only MCP reference for World of Warcraft 3.3.5a build 12340. The current local reference contains the curated Offsets catalog.

Requires Node.js 24.15.0 or newer and Vite+ for development. Build and run a local reference:

```bash
vp install
vp run build
vp run build:reference reference.sqlite
WOTLK_MCP_DB="$PWD/reference.sqlite" node dist/index.mjs
```

The last command starts an MCP server over stdio; connect an MCP client rather than typing commands into it. `WOTLK_MCP_DB` must point to a compatible database. No database is bundled or downloaded yet. The `get` tool accepts up to 20 kind-qualified IDs, such as `offset:Globals::PlayerName`.

The package code is MIT licensed; the database contains source data with separate provenance recorded in its `source` table.

## Development

- Install dependencies:

```bash
vp install
```

- Run the unit tests:

```bash
vp test
```

- Validate the curated Offsets JSON and unique paths:

```bash
vp run validate:offsets
```

The 13 documents in `data/offsets` use the schema in `data/offsets.schema.json`. After changing the Zod schema in `src/offsets.ts`, regenerate it with `vpx scripts/validate-offsets.ts --schema > data/offsets.schema.json`. Topic names have no semantic significance; paths omit only `WoWOffsets::`. The migration test compares against the original C++ declarations preserved in `tests/fixtures/original-offsets.txt` from commit `34504ad`. See [address conventions](docs/offsets/address-conventions.md) and [Windows x86 provenance](docs/offsets/windows-x86.md) before using an entry.

To add the pinned Codex Lua API to a freshly built local reference, check out `https://github.com/Shard-MW/milkyway-codex` at `e4e31fb62be318fd7403152aa73b33ef6c70f5fa`, then run:

```bash
vp run import:codex -- reference.sqlite /path/to/milkyway-codex
```

The importer verifies each directly imported TypeScript data file against `data/codex-pins.json` before executing it with Node's type stripping; it does not build the upstream application or import its DBC data. The optional third argument selects an alternate pins manifest for isolated fixtures. The source manifest records the revision and a combined hash (sorted in importer file order, each path followed by a NUL and its file bytes). The Codex has no declared licence; the owner accepts the redistribution risk, which is not evidence of permission. Codex `memoryAddress` values are unverified source claims and are never used as native linking evidence.

- Build the executable:

```bash
vp pack
```

## Extracting maintainer client inputs

On macOS or Linux, install Git, CMake, a C++ compiler and Python 3, then run:

```bash
./extract-client.sh /path/to/trusted-client /path/to/new-client-inputs
```

The client directory must contain `Wow_Original.exe` and the complete enGB archive set under `Data`. The launcher builds StormLib at commit `6bb1882bd00ddbc3729cac5dac0fda81a61e5514`. It verifies the original executable SHA-256 before reading archives and rejects the installed large-address-aware `Wow.exe` variant. The executable is never copied.

The output contains DBC files, FrameXML, GlueXML and Blizzard addon Lua, XML and TOC files, plus `manifest.json` with archive and file SHA-256 hashes, winning archives, extractor revision and library hash. Later archives win; deletion markers remove earlier files. An output directory must not already exist. The inventory uses enGB as the accepted English stand-in: enUS byte identity has not been verified. Keep client-derived files private until the owner performs the trusted-client production bundle and publication in #30; the command's development fixtures do not replace that proof.

The selected path set is checked against the lowercase, sorted inventory from fingerprint research commit `6aaec0a94f70848127c155aa627554e5e9cad3b6`. The two `Interface/LCDXML` XML files observed in that research are outside the specified Interface directories and are recorded as exclusions. The manifest also records the actual library hash, compiler, CMake, Python and host versions; these describe the build environment rather than claiming a byte-identical compiler environment on every host.

The synthetic archive test uses a local StormLib shared library. Set `STORMLIB_TEST_LIBRARY` to its absolute path if it is not installed at the default macOS or Linux location.
