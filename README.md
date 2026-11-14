# wotlk-mcp

A read-only MCP reference for World of Warcraft 3.3.5a build 12340. The current local reference contains the curated Offsets catalog.

Requires Node.js 24.15.0 or newer and Vite+ for development. Build and run a local reference:

```bash
vp install
vp run build
vp run build:reference -- reference.sqlite
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

- Build the executable:

```bash
vp pack
```

## Releasing the npm package

Package releases are independent of `db-v<semver>` database releases. Set the package version explicitly in `package.json` and tag the same commit `v<version>`. The tag starts `.github/workflows/package-release.yml`. Its guard requires a published, non-prerelease database of the accepted schema major, downloads and verifies its GitHub SHA-256 digest, and checks the database's schema metadata before publishing. It also rejects an already published package version and a schema-major change within an existing package major. Keep old immutable database releases available for older package majors; data-only updates do not require npm releases.

`src/schema.ts` hard-codes the accepted schema major and `wotlkSchemaMajor` in the package metadata records it for future release comparisons. Update both together. A schema-major change or breaking tool-contract change requires a new package major; review tool-contract changes explicitly before tagging. Publish the compatible database first. Never delete old database releases as part of a package release.

For #52, the owner must first ensure the unscoped `wotlk-mcp` package exists and is under their control: npm's [trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires an existing package. If necessary, npm documents that staging a new package creates a public placeholder; this bootstrap is a separate owner authorization, not performed by this workflow. In npm package settings configure GitHub Actions trusted publishing with organization/user `denisdasilvarocha`, repository `wotlk-mcp`, workflow filename `package-release.yml`, no environment, and **Allow npm publish**. Do not grant dist-tag management. Configure it only when ready: npm expires an unused new trust configuration after two days. The repository and package must be public for automatic provenance. The GitHub-hosted workflow uses npm CLI 11.5.1 or newer, `id-token: write`, and no stored npm token. The owner should restrict token publishing after OIDC works. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

If npm publication succeeds but GitHub release creation fails, the package version cannot be published again; create the missing GitHub release for the existing tag after inspecting the failed job rather than retrying publication.

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
