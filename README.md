# wotlk-mcp

A read-only MCP reference for World of Warcraft 3.3.5a build 12340.

> **Release status:** This repository is private. The npm package and production database have not been published; the examples below describe the intended public installation and do not currently provide a public live service. The separately authorized client-inputs release is private. World Data acceptance approval is still deferred.

## Connect a client

Install [Node.js](https://nodejs.org/) **24.15.0 or newer**, including npm. Once the package and compatible database are published, configure one of the following stdio clients. They launch a local process; this server does not provide HTTP.

### Claude Code

On macOS or Linux, use the [Claude Code MCP command](https://code.claude.com/docs/en/mcp):

```sh
claude mcp add --transport stdio wotlk -- npx -y wotlk-mcp@1
```

On Windows:

```text
claude mcp add --transport stdio wotlk -- cmd /d /s /c "npx -y wotlk-mcp@1"
```

### Codex

In `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`), following the [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp#stdio-servers):

```toml
[mcp_servers.wotlk]
command = "npx"
args = ["-y", "wotlk-mcp@1"]
```

On Windows replace those two lines with:

```toml
command = "cmd"
args = ["/d", "/s", "/c", "npx -y wotlk-mcp@1"]
```

### OMP

In `.omp/mcp.json` for a project or `~/.omp/agent/mcp.json` for the default user profile:

```json
{
  "mcpServers": {
    "wotlk": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "wotlk-mcp@1"]
    }
  }
}
```

On Windows use `"command": "cmd"` and `"args": ["/d", "/s", "/c", "npx -y wotlk-mcp@1"]` in the same entry. Merge the entry into an existing config rather than replacing other servers. These examples pin the package major; upgrading to a new major is deliberate.

## Use the reference

Ask your client to search for a name, then retrieve the resulting ID. The server exposes exactly four tools:

| Tool | Purpose |
| --- | --- |
| `search` | Find literal terms with ranked, paginated hits; `kind` is an optional array of kinds. Source lines are searched only when `file` is explicitly included. |
| `get` | Fetch up to 20 IDs with full Record details. Empty fields are omitted; for `file:` IDs, `from` and `to` select one-based inclusive line windows, with continuation for longer files. |
| `related` | Browse one-hop Links in either direction, optionally filtered by relation, with pagination. |
| `sql` | Query raw source tables or discover the schema using one read-only statement. |

IDs are kind-qualified, for example `spell:53`, `offset:Globals::PlayerName`, or `file:FrameXML/ChatFrame.lua`. Kinds are `spell`, `talent`, `itemset`, `skillline`, `map`, `area`, `faction`, `class`, `race`, `achievement`, `creature`, `item`, `quest`, `gameobject`, `fn`, `event`, `widget`, `method`, `cvar`, `type`, `cle`, `template`, `slash`, `offset`, and `file`. A kind belongs to one source; Client Data and World Data overrides are not merged. Records preserve source provenance; `source` also lists pins, hashes and licences.

For SQL discovery, try `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name` and `PRAGMA table_info('world_item_template')`. Source tables use `dbc_`, `world_`, `lua_`, `offsets_` and `ui_` prefixes. SQL permits SELECT and the `table_info`, `table_xinfo`, `table_list`, `index_list`, and `foreign_key_list` PRAGMAs; writes, attaching databases, extension loading and other introspection are denied. The default row limit is 100, maximum 1,000; output is capped at 32,000 UTF-16 code units and expensive queries time out after five seconds. Output is tab-separated with escaped cells and an explicit truncation marker.

This is reference data, not a live-client integration: it does not attach to the game, read process memory or talk to a game server. Source text and query results are data, not trusted instructions.

## Database and updates

No database is bundled with the package. On first use, the server downloads a compatible published GitHub release, verifies the compressed SHA-256 digest and schema, and caches it. A tool call waits up to 20 seconds for the first download; if still pending, retry. Network access is needed for the first download unless you provide a local database.

Cached starts and queries do not wait for update metadata. The server tries an update check in the background at most once per 24 hours, including failed attempts. It retains the selected snapshot for the session; a verified update or an older release used as a rollback takes effect on the next start. Offline starts use the cache, falling back to the previous usable copy when necessary. Package major 1 accepts database schema major 1. If a newer database needs a higher package major, the server writes a warning to stderr and appends it once to the first tool response after the warning becomes known; upgrade the package deliberately.

| Environment variable | Purpose |
| --- | --- |
| `WOTLK_MCP_DB` | Path to a compatible local SQLite reference. Disables network access; an invalid override fails rather than falling back. |
| `GITHUB_TOKEN` or `GH_TOKEN` | Optional GitHub token for release requests, useful for rate limits or an authorized private repository. Keep tokens out of committed configuration and use only the access required. |

## Rights and provenance

The independently authored package code is [MIT licensed](LICENSE). The database contains mixed-rights material and is **not** blanket MIT: consult the `source` table and the `NOTICE.md` accompanying each database release. The owner's verified enGB extraction is an accepted English stand-in for the enUS target, not proof of full enUS byte identity. The owner accepts the risks of redistributing Blizzard-derived material and using the unlicensed Codex source; acceptance is not permission or a licence grant. See the private [client-inputs release notice](https://github.com/denisdasilvarocha/wotlk-mcp/releases/tag/client-inputs-12340-engb-1) and [database releases](https://github.com/denisdasilvarocha/wotlk-mcp/releases) when available.

## Development

- Install dependencies:

```bash
vp install
```

For a local Offsets-only reference and stdio process, run:

```bash
vp run build
vp run build:reference reference.sqlite
WOTLK_MCP_DB="$PWD/reference.sqlite" node dist/index.mjs
```

Connect an MCP client to that process; it is not an interactive shell. This local reference is not the production database.

To add the verified Interface source to an existing reference, use the extracted inputs and independently trusted manifest digest:

```bash
vp run import:interface reference.sqlite /path/to/client-inputs MANIFEST_SHA256
```

- Run the unit tests:

```bash
vp test
```

- Validate the curated Offsets JSON and unique paths:

```bash
vp run validate:offsets
```

The 13 documents in `data/offsets` use the schema in `data/offsets.schema.json`. After changing the Zod schema in `src/offsets.ts`, regenerate it with `vpx scripts/validate-offsets.ts --schema > data/offsets.schema.json`. Topic names have no semantic significance; paths omit only `WoWOffsets::`. The migration test compares against the original C++ declarations preserved in `tests/fixtures/original-offsets.txt` from commit `34504ad`. See [address conventions](docs/offsets/address-conventions.md) and [Windows x86 provenance](docs/offsets/windows-x86.md) before using an entry. Release acceptance runs the actual packed executable against a candidate SQLite database:

```bash
vpx scripts/acceptance.ts /path/to/wotlk-mcp.tgz /path/to/candidate.sqlite tests/fixtures/acceptance.json
```

The cited fixtures include **unapproved** World Data candidates. The command fails until a maintainer reviews the exact assertions in `docs/world-data-facts.md` and records approval in `data/world-acceptance-approval.json`: `status` must be `approved`, with `reviewer`, ISO `date`, a URL `record` to the durable review, `fixtures_sha256` for the exact fixture file, and `world_cases` listing every approved World case ID. Changes to any fixture require a new approval digest. This is not a publication command. A local candidate is not a substitute for the verified draft asset and six-cell release matrix.

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

## Releasing the npm package

For database candidate preparation, gated publication and rollback, see the [database release guide](docs/releases.md).

Package releases are independent of `db-v<semver>` database releases. Set the package version explicitly in `package.json` and tag the same commit `v<version>`. The tag starts `.github/workflows/package-release.yml`. Its guard requires a published, non-prerelease database of the accepted schema major, downloads and verifies its GitHub SHA-256 digest, and checks the database's schema metadata before publishing. It also rejects an already published package version and a schema-major change within an existing package major. Keep old immutable database releases available for older package majors; data-only updates do not require npm releases.

`src/schema.ts` hard-codes the accepted schema major and `wotlkSchemaMajor` in the package metadata records it for future release comparisons. Update both together. A schema-major change or breaking tool-contract change requires a new package major; review tool-contract changes explicitly before tagging. Publish the compatible database first. Never delete old database releases as part of a package release.

For #52, the owner must first ensure the unscoped `wotlk-mcp` package exists and is under their control: npm's [trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires an existing package. If necessary, npm documents that staging a new package creates a public placeholder; this bootstrap is a separate owner authorization, not performed by this workflow. In npm package settings configure GitHub Actions trusted publishing with organization/user `denisdasilvarocha`, repository `wotlk-mcp`, workflow filename `package-release.yml`, no environment, and **Allow npm publish**. Do not grant dist-tag management. Configure it only when ready: npm expires an unused new trust configuration after two days. The repository and package must be public for automatic provenance. The GitHub-hosted workflow uses npm CLI 11.5.1 or newer, `id-token: write`, and no stored npm token. The owner should restrict token publishing after OIDC works. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

If npm publication succeeds but GitHub release creation fails, the package version cannot be published again; create the missing GitHub release for the existing tag after inspecting the failed job rather than retrying publication.

## Build the complete reference

Authenticate `gh` with read access to the private client-inputs release. On a Docker host with both linux/arm64 and linux/amd64 support, run from the repository root with a new output directory and sufficient disk space:

```bash
vp run build:complete-reference /absolute/path/to/new-output
```

The command downloads the pinned client asset, Codex, WoWDBDefs and AzerothCore sources and verifies their hashes before ingestion. It creates a fresh pinned MySQL service, runs the upstream updater, imports all sources and Links, generates the fidelity report and `NOTICE.md`, and writes `wotlk.sqlite`, `wotlk.sqlite.br` and `build-report.json`. The disposable MySQL service and network are removed after export. The output directory also contains the verified client inputs and must be handled according to their mixed rights.

`fidelity.json` reports discrepancies without changing either source. The build report records measured sizes and timings; an asset above 250 MB requires an explicit scope decision, not removal of required source content. Building an artifact does not authorize publication: release integrity, previous-release comparisons, independent acceptance, and other approval gates remain separate.

## Reproduce World Data

Requires Docker with linux/arm64 and linux/amd64 support, `curl`, `openssl`, `patch`, and a POSIX shell. Download the pinned AzerothCore archive and provide a new output directory:

```bash
curl -fL https://codeload.github.com/azerothcore/azerothcore-wotlk/tar.gz/2948c203faa0d23c4772441119ebe98e5b7cad95 -o azerothcore.tar.gz
sh world/reproduce.sh azerothcore.tar.gz world-output
```

The command verifies the archive, builds the pinned upstream database importer, creates isolated fresh databases, applies upstream updates, and compares the selected World Data schema to the committed manifests. The output contains the importer log, observed schema, and a report; it does not publish data. On success the report names the running MySQL container and its private network for the export step. Remove both with `docker rm -f <container>` and `docker network rm <network>` when finished.

To add World Data to a newly built reference, pass the container name from the report and the reference database path:

```bash
vp run build:reference reference.sqlite
vpx scripts/export-world.ts <container> reference.sqlite
```

The exporter checks the selected schema, stores the source tables with the `world_` prefix, and indexes creature, item, quest and gameobject Records. The source's `*_dbc` overrides remain separate from Client Data. Spawn rows retain their stored map, coordinates, zone and area values; no area is inferred. The reference's source and metadata tables record the pin and export evidence. The pinned AzerothCore [licence](world/azerothcore-LICENSE.txt) and [authors notice](world/azerothcore-AUTHORS.txt) accompany these sources. The database also contains data with separate rights; the package's MIT licence does not apply to the database as a whole.

After importing World Data, run `vpx scripts/build-loot.ts reference.sqlite` to build `drops` Links. The command uses the creature loot, skinning and pickpocket keys, chest and fishing-hole loot keys, and container-item entries; it follows nested references using their absolute IDs. Notes retain the stored chance, group, quest requirement, loot mode, counts and reference path for each contributing row. A conditions marker points to `world_conditions`; all original rows remain queryable through SQL. These values are not effective drop probabilities. Missing or cyclic references abort the transaction with the source row and path.

SQLite REAL cannot retain the sign of negative zero. The exporter rejects a source negative zero with a table, column and value diagnostic rather than changing its SQL type or silently losing the sign. Ordinary floating-point values remain REAL.

Use the unmodified container created by the reproduction command; schema checks alone cannot prove the contents came from that source. The [observed pinned export](world/export-proof.json) records per-table counts and logical hashes; [proof details](world/proof.txt) describe the run and independent source checks.

After importing both World Data and Client Data, run `vpx scripts/build-world-links.ts reference.sqlite` to derive quest, reward, vendor, default-trainer and item-spell Links from their stored keys. Only existing Records become endpoints; original World Data rows remain available through SQL. Notes identify reward and spell slots, vendor details and trainer keys; scripts and names are not used to infer Links.

The build-only patch removes links to disabled scripts and modules; updater code is unchanged. Custom and module SQL are rejected. The local container uses disposable, known credentials and must not be exposed to an untrusted network.

## Database release gate

After the complete reference build, run `vpx scripts/release-gate.ts candidate/wotlk.sqlite candidate/wotlk.sqlite.br [previous.sqlite] --prepare` to calculate and store the required database version. Supply the previous published database except for the first release. Recompress the updated SQLite file with Brotli, then run the same command without `--prepare`; only that final successful run validates the actual compressed asset and permits the release workflow to proceed. The command prints JSON with the computed version, per-table/kind/relation counts and byte sizes. It rejects a compressed asset over 250,000,000 bytes or one that does not decompress to the candidate. `--allow-shrink` explicitly approves counts shrinking by more than five percent; it does not bypass other checks. Preparation is not a publication approval: acceptance matrix and other release obligations remain separate.

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

## Importing Client Data

Build the reference first, then supply the extracted client directory, the independently pinned SHA-256 of its `manifest.json`, and the upstream archive:

```bash
curl -L https://codeload.github.com/wowdev/WoWDBDefs/tar.gz/fe771f93091b18db417c99621cfe9e36a228a590 -o wowdbdefs.tar.gz
vpx scripts/import-client-data.ts reference.sqlite /path/to/client-inputs MANIFEST_SHA256 wowdbdefs.tar.gz
```

The importer verifies the manifest, every imported DBC and the definition archive SHA-256 `b35205cb31c27204f05ae8528ca214af02381585f5d0d2697bea30a2d58123ca`. It imports build 12340 layouts into `dbc_` tables, expands arrays with one-based suffixes, and records definition references in `dbc_foreign_key`. The enGB extraction remains an English stand-in, not proof of enUS identity. The local extraction is not the reviewed or published #30 production asset.

After importing both Client Data and World Data into the same reference, build their item-set, talent-rank, skill-line, faction and stored-spawn Links:

```bash
vp run build:client-faction-spawn-links -- reference.sqlite
```

The command uses existing Records only and leaves all source rows intact. Creature spawn counts include stored alternate entries in `world_creature_multispawn`, counting each spawn once per creature and map. Counts are stored rows, not probabilities or inferred areas. Item-set members absent from World Data are omitted from Links and remain a report-only fidelity discrepancy.

After importing both World Data and Client Data into the same reference, populate the World Data enum and reference mappings using the same hash-verified AzerothCore archive used for reproduction:

```bash
vp run import:world-enums -- reference.sqlite azerothcore.tar.gz
```

This command validates mapped columns and pinned header definitions, and fails if the Client Data required for English reference names is missing. `get` presents mapped names after raw values; SQL and search remain raw. Unknown values, unknown flag bits, sentinel `-1`, and missing referenced rows are not invented. The parsed header definitions are from AzerothCore at commit `2948c203faa0d23c4772441119ebe98e5b7cad95` and retain its GPL-2.0-or-later licence and attribution in `world/azerothcore-LICENSE.txt` and `world/azerothcore-AUTHORS.txt`.

After those imports, add the Spell enum families and build-specific Client Data foreign-key annotations with the same archive:

```bash
vp run import:spell-enums -- reference.sqlite azerothcore.tar.gz
```

The command validates Spell columns and pinned AzerothCore enums, and materializes available English reference names into the shared decoder tables. References whose target table or named row is unavailable retain their raw values; neither command changes source rows.

WoWDBDefs definitions are copyright WoWDBDefs Contributors and licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The importer transforms those definitions into database columns and foreign-key metadata; retain attribution, indicate these changes, provide the licence and source at the pinned [revision](https://github.com/wowdev/WoWDBDefs/tree/fe771f93091b18db417c99621cfe9e36a228a590), and comply with applicable share-alike obligations in database releases.

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
