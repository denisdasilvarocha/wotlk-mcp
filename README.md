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

### Pinned client-inputs asset

The owner-approved input release is `client-inputs-12340-engb-1`, asset `client-inputs-12340-engb-1.tar.gz`, SHA-256 `9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136`. The committed `data/client-inputs/manifest.json` records every input file and source archive hash, the original executable fingerprint and extraction environment. This is Blizzard-derived material and this project's native registration dump, not MIT-licensed package code; redistribution risk is accepted by the owner, not a claim of permission. The executable is never included.

For the private repository, authenticate `gh` as a principal with release-read access, then download and verify before ingestion:

```bash
gh release download client-inputs-12340-engb-1 --repo denisdasilvarocha/wotlk-mcp --pattern client-inputs-12340-engb-1.tar.gz --dir .
python3 scripts/verify-client-inputs.py client-inputs-12340-engb-1.tar.gz
```

For the authorized one-time publication of these exact bytes, the preflight must find neither the tag nor release; it must fail closed on a GitHub API error. The command creates the release only after verification, never replaces an asset, and must not be rerun to alter a published release:

```bash
set -euo pipefail
python3 scripts/verify-client-inputs.py client-inputs-12340-engb-1.tar.gz
gh api graphql -f query='query { repository(owner:"denisdasilvarocha", name:"wotlk-mcp") { ref(qualifiedName:"refs/tags/client-inputs-12340-engb-1") { id } release(tagName:"client-inputs-12340-engb-1") { id } } }' --jq '.data.repository | .ref == null and .release == null' | jq -e . >/dev/null
gh release create client-inputs-12340-engb-1 client-inputs-12340-engb-1.tar.gz --repo denisdasilvarocha/wotlk-mcp --target main --latest=false --title 'Client inputs 12340 enGB 1' --notes 'Owner-approved enGB client extraction for build 12340; English stand-in, not verified enUS identity. Includes DBC and eligible Interface source files, native registration dump, and SHA-256 manifest; no client executable. Blizzard-derived content carries separately accepted redistribution risk, not MIT package licensing. Asset SHA-256: 9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136. Immutable by project policy: do not replace assets or reuse this tag.'
```

The verifier checks the pinned bundle and committed manifest hashes, inventory, permitted paths and every file hash without extracting the archive. The release is immutable by project policy: never replace an asset or reuse a tag; publish a new pin for any changed bytes. GitHub's repository-wide immutable releases setting is not enabled, so GitHub does not enforce that policy. No database or npm release is implied.

The asset is enGB, accepted as an English stand-in, not proven byte-identical to enUS. [Fingerprint research](https://github.com/denisdasilvarocha/wotlk-mcp/issues/14) found enGB `Localization.lua` and a calendar first-weekday difference compared with the older enUS 12213 Interface snapshot; `GlobalStrings.lua` matched. Fourteen locale-sourced DBC text tables differed from an independent dump; that comparison does not prove enUS identity. Three `Blizzard_GMChatUI.lua` lines also differed and were considered a likely build-12340 hotfix, not established locale corrections. These differences are flagged, not silently patched.
