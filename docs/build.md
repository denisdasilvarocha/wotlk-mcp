# Build the complete reference

Build the complete local reference and stdio server from the repository root. Building does not authorize publication; see [release operations](releases.md).

## Prerequisites

Install Node.js 24.15.0 or newer, [Vite+](https://viteplus.dev/guide/) (`vp` and `vpx`), Git, Python 3, `tar`, and the GitHub CLI (`gh`), authenticated with release-read access to the private `denisdasilvarocha/wotlk-mcp` client-inputs release. Docker with Buildx must be able to run linux/amd64 images, using emulation where necessary. Allow disk space for sources, disposable MySQL databases and output.

## Build and outputs

```sh
vp install
vp run build
```

The command creates a fresh `output/`, acquires inputs, constructs the reference and packs the server and SQL worker. It prints the database path and a shell-quoted command for launching the server. Outputs include `wotlk.sqlite`, `wotlk.sqlite.br`, `fidelity.json`, `NOTICE.md` and `build-report.json`, along with acquired inputs and evidence. Handle client-derived inputs according to their mixed rights.

An existing destination, even an empty directory, is refused before acquisition. For another build use `vp run build ./output-next` or choose another new path. A failed build retains its partial output for diagnosis; it cannot be resumed. The error identifies the failed stage and, if created, `world/updater.log` under the output directory. Remove partial output yourself only after inspecting it, or use a different fresh directory. `vp run build --help` describes the interface.

`fidelity.json` reports discrepancies without changing source data. The build report records sizes and timings; an asset above 250 MB requires an explicit scope decision, not removal of required source content. Publication requires separate release integrity, comparison and approval gates.

## Latest-source selection and integrity

- The fixed build-12340 client bundle is downloaded with authenticated `gh` from release `client-inputs-12340-engb-1`, asset `client-inputs-12340-engb-1.tar.gz`. The verifier checks its independently committed bundle and manifest hashes, permitted paths, inventory and file hashes before extraction. The bundle SHA-256 is `9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136`; the manifest SHA-256 is `e5db5940f6e7ca8b3862c5c27b1a08cdc45571d79bd2ba9607540a5e432f3235`.
- WoWDBDefs `master` is resolved once to a commit; its archive is downloaded and hashed once. That calculated hash records the downloaded bytes and detects subsequent changes; it is not an independently reviewed upstream checksum. Build-12340 layouts and required fields remain validated.
- World Data follows the latest officially published `acore/ac-wotlk-db-import:master` importer, resolved to an immutable image digest. Buildx provenance for linux/amd64 must attest the canonical AzerothCore repository and commit; the matching source archive supplies SQL, headers and attribution. This published importer/source pair may lag branch HEAD. The updater runs against fresh isolated MySQL, rejects custom/module SQL and requires the committed selected-schema manifests to match.
- Codex `main` is resolved once and checked out at the verified detached commit. The eight consumed data files are hashed and reverified immediately before evaluation. Their aggregate hashes each ordered path, a NUL and its file bytes. Evaluation runs in a digest-resolved official Node 24 Alpine container with no network, a read-only filesystem and checkout, no forwarded secrets and a 60-second limit; it imports only the consumed data exports. Container isolation reduces exposure to upstream code, not a guarantee against malicious code.

Source revisions, hashes and image identities are recorded in the database's `source` and metadata. Missing provenance, failed verification, incompatible source layouts or invalid data stop the build rather than falling back to old inputs or omitting a domain. A successful later build can contain upstream corrections.

## Domain interpretation

Client Data imports full build-12340 DBC layouts into `dbc_` tables, expands arrays with one-based suffixes and records definition references in `dbc_foreign_key`. WoWDBDefs is copyright its contributors and licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); database releases must retain attribution, indicate transformations, provide the licence and resolved source revision, and comply with applicable share-alike obligations.

World Data retains its original `world_` source tables and indexes creature, item, quest and gameobject Records. Its `*_dbc` overrides stay separate from Client Data. Spawns retain stored map, coordinates, zone and area; no area is inferred. The importer validates the selected schema and scans typed counts and hashes across MySQL and SQLite. SQLite REAL cannot retain negative zero, so a source negative zero fails with a table, column and value diagnostic rather than being silently changed. Historical per-table counts and logical hashes are in [export proof](../data/world/export-proof.json), with [proof details](../data/world/proof.txt).

World Links derive quest, reward, vendor, default-trainer and item-spell relationships from stored keys, with only existing Records as endpoints. Notes identify reward and spell slots, vendor details and trainer keys; scripts and names do not infer Links. Loot Links follow creature loot, skinning and pickpocket keys, chest and fishing-hole keys, container items and nested absolute reference IDs. Notes preserve stored chance, group, quest requirement, loot mode, counts and reference path; a conditions marker points to `world_conditions`. These are not effective drop probabilities. Missing or cyclic references abort with the source row and path.

Client/faction/spawn Links preserve source rows. Spawn counts include stored alternate entries in `world_creature_multispawn`, counting each spawn once per creature and map; counts are not probabilities or inferred areas. Item-set members missing from World Data remain a report-only fidelity discrepancy. Enum mappings use headers from the same resolved World source and validate mapped columns. `get` presents mapped names after raw values; SQL and search remain raw. Unknown values and flag bits, sentinel `-1`, and unavailable reference rows are not invented. Source rows remain unchanged.

Codex has no declared licence; the owner's acceptance of redistribution risk is not permission. Its `memoryAddress` values are unverified source claims, never native-link evidence. Native ingestion verifies the client manifest, native dump hash and executable fingerprint, retaining glue/game contexts, registration table and row, callback VA and call site. `implemented by` Links require equal curated VAs. Widget decisions use independently supported table identities, not name similarity; inherited methods require an explicit Codex inheritance path and exactly one declaring ancestor. Ambiguous methods remain raw, and registration context is retained.

### Historical client-input provenance

The published asset contains DBC files, FrameXML, GlueXML and Blizzard addon Lua, XML and TOC files, a native registration dump and manifest, but no client executable. The original executable fingerprint is `aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8`. Its historical extraction used StormLib commit `6bb1882bd00ddbc3729cac5dac0fda81a61e5514`; the manifest records the actual library hash, extraction environment, archive and file hashes and winning archives. Later archives won and deletion markers removed earlier files. The selected inventory was checked against fingerprint research commit `6aaec0a94f70848127c155aa627554e5e9cad3b6`; two `Interface/LCDXML` XML files outside the specified Interface directories were recorded as exclusions.

The owner's enGB extraction is an accepted English stand-in, not proof of enUS byte identity. [Fingerprint research](https://github.com/denisdasilvarocha/wotlk-mcp/issues/14) found differences in `Localization.lua` and the calendar first weekday against an older enUS 12213 snapshot, while `GlobalStrings.lua` matched. Fourteen locale-sourced DBC text tables differed from an independent dump; three `Blizzard_GMChatUI.lua` lines differed and were considered a likely build-12340 hotfix, not established locale corrections. These differences are flagged, not silently patched.

The offline native scanner covers the fingerprinted client's known global registrar and widget iterator paths, not Lua-defined functions or other registration mechanisms. The curated `data/native-widget-decisions.json` uses `overrides` and `missing_widgets` keyed by table VA, with a widget, the hash of sorted distinct method names and an independent-evidence reason. The allowlist covers independently identified widgets absent from Codex, preserving raw rows without association or Links. Missing, ambiguous, stale and unused decisions fail the transaction.

The documented binary evidence connects the iterator's method-table callback to its initializer, which saves the Lua registration token. A virtual method returns that exact token, while the slot 20 bytes later in the same class vtable returns the named type string. The common vtable identifies the class; merely finding nearby strings or similar method names would not establish this association. The shared base callback is called at `0x0049CA98` before Region's own registration and uses the exact Codex ParentedObject and UIObject inherited-method union.

## Troubleshooting

- **Client asset unavailable:** authenticate `gh` with release-read access to `denisdasilvarocha/wotlk-mcp` and the named private release and asset. Authentication does not grant redistribution rights.
- **Image or provenance failure:** check Docker/Buildx, linux/amd64 execution and registry access. The diagnostic names the image; missing or malformed attestation cannot be replaced by guessing a source revision.
- **Schema, layout or native decision failure:** inspect the reported source revision and table, header or registration evidence. Latest upstream changes can be incompatible; do not silently downgrade, omit data or relax validation.
- **Build interrupted or failed:** inspect the retained partial directory and World updater log, if present. Use a fresh destination for another build; no automatic resume or deletion is provided.

## Developer maintenance

Validate the curated Offsets JSON and unique paths with `vpx scripts/validate-offsets.ts`. After changing the Zod schema in `build/offsets.ts`, regenerate it with:

```sh
vpx scripts/validate-offsets.ts --schema > data/offsets.schema.json
```

Topic names have no semantic significance; paths omit only `WoWOffsets::`. The migration test compares against the original C++ declarations in `tests/fixtures/original-offsets.txt` from commit `34504ad`. See [address conventions](offsets/address-conventions.md) and [Windows x86 provenance](offsets/windows-x86.md) before using an entry.
