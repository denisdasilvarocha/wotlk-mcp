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

After the Codex import, `vp run import:native -- reference.sqlite /path/to/client-inputs <manifest-sha256> [overrides.json]` imports the fingerprint-derived registrations. Supply the independently trusted SHA-256 of `manifest.json`; the command checks its native dump hash and executable fingerprint. It retains raw glue/game registrations, table and row identity, and call sites. `get` shows associated native facts; `implemented by` links are created only for equal curated VAs, never from Codex `memoryAddress`.

Every native method table must match exactly one Codex widget's own method names. The optional decisions JSON contains `overrides` and `missing_widgets` maps keyed by table VA. Each entry supplies `widget`, `methods_sha256` (SHA-256 of the JSON array of distinct method names in sorted order), and an independent-evidence `reason`. Overrides identify a widget from evidence, not similarity. For inherited methods, association requires an explicit Codex inheritance path and exactly one declaring ancestor; native facts and Link notes retain the registering widget, so an override callback is not presented as a universal ancestor implementation. Ambiguous methods remain raw. The owner-approved `missing_widgets` allowlist is limited to independently identified widgets absent from Codex and preserves their rows without association or Links. Missing, ambiguous, stale and unused decisions fail the transaction. Decisions in `data/native-widget-decisions.json` refer to executable SHA-256 `aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8`.

The documented binary evidence connects the iterator's method-table callback to its initializer, which saves the Lua registration token. A virtual method returns that exact token, while the slot 20 bytes later in the same class vtable returns the named type string. The common vtable identifies the class; merely finding nearby strings or similar method names would not establish this association. The shared base callback is called at `0x0049CA98` before Region's own registration and uses the exact Codex ParentedObject and UIObject inherited-method union.

- Build the executable:

```bash
vp pack
```

## Reproduce World Data

Requires Docker with linux/arm64 and linux/amd64 support, `curl`, `openssl`, `patch`, and a POSIX shell. Download the pinned AzerothCore archive and provide a new output directory:

```bash
curl -fL https://codeload.github.com/azerothcore/azerothcore-wotlk/tar.gz/2948c203faa0d23c4772441119ebe98e5b7cad95 -o azerothcore.tar.gz
sh world/reproduce.sh azerothcore.tar.gz world-output
```

The command verifies the archive, builds the pinned upstream database importer, creates isolated fresh databases, applies upstream updates, and compares the selected World Data schema to the committed manifests. The output contains the importer log, observed schema, and a report; it does not publish data. On success the report names the running MySQL container and its private network for the export step. Remove both with `docker rm -f <container>` and `docker network rm <network>` when finished.

The build-only patch removes links to disabled scripts and modules; updater code is unchanged. Custom and module SQL are rejected. The local container uses disposable, known credentials and must not be exposed to an untrusted network.

## Extracting maintainer client inputs

On macOS or Linux, install Git, CMake, a C++ compiler and Python 3, then run:

```bash
./extract-client.sh /path/to/trusted-client /path/to/new-client-inputs
```

The client directory must contain `Wow_Original.exe` and the complete enGB archive set under `Data`. The launcher builds StormLib at commit `6bb1882bd00ddbc3729cac5dac0fda81a61e5514`. It verifies the original executable SHA-256 before reading archives and rejects the installed large-address-aware `Wow.exe` variant. The executable is never copied.

The output contains DBC files, FrameXML, GlueXML and Blizzard addon Lua, XML and TOC files, `native-registrations.json`, and `manifest.json` with archive and file SHA-256 hashes, winning archives, extractor revision and library hash. The native dump reads the fingerprinted PE's registration tables offline and retains each table, row index, callback VA, call site and glue/game context. Widget names are not inferred from method sets; consumers must resolve each table independently. Later archives win; deletion markers remove earlier files. The output directory must not already exist. The inventory uses enGB as the accepted English stand-in: enUS byte identity has not been verified. Keep client-derived files private until the owner performs the trusted-client production bundle and publication in #30; the command's development fixtures do not replace that proof.

The selected path set is checked against the lowercase, sorted inventory from fingerprint research commit `6aaec0a94f70848127c155aa627554e5e9cad3b6`. The two `Interface/LCDXML` XML files observed in that research are outside the specified Interface directories and are recorded as exclusions. The manifest also records the actual library hash, compiler, CMake, Python and host versions; these describe the build environment rather than claiming a byte-identical compiler environment on every host.

The synthetic archive test uses a local StormLib shared library. Set `STORMLIB_TEST_LIBRARY` to its absolute path if it is not installed at the default macOS or Linux location.

The PE fixture checks section-based VA translation, a global shared by both contexts, a game-only global, a shared method table, and inventory hashing. It models registration instructions, not the complete executable. The actual fingerprinted executable must also be extracted and its result reviewed before the #30 production publication gate. The scanner covers the pinned client's known global registrar and widget iterator paths; it does not claim coverage of Lua-defined functions or other registration mechanisms.
