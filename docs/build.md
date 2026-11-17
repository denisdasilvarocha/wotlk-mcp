# Build the reference

`vp run build` builds the complete reference database and the stdio server from upstream sources. Use it to run the server before a database release exists, to test pipeline changes, or to prepare a release candidate.

Building does not publish anything. See [Release operations](releases.md) for publication.

## Before you begin

You need:

- Node.js 24.15.0 or newer
- [Vite+](https://viteplus.dev/guide/) (`vp` and `vpx`)
- Git, Python 3 (`python3`), and `tar`
- The GitHub CLI (`gh`), signed in with read access to this repository's releases. The client inputs are a release asset of this private repository.
- Docker with Buildx that can run linux/amd64 images, using emulation on other architectures
- Network access to GitHub and Docker Hub
- Several GB of free disk space. The database alone is about 2.2 GB, and the build keeps its downloaded inputs.

Run `vp install` once after cloning. See [Development](development.md) for the rest of the setup.

## Run the build

```sh
vp run build
```

The build writes to `output/`. The destination must not exist yet, even as an empty directory; otherwise the build stops before changing anything. To build again, choose a new directory:

```sh
vp run build ./output-next
```

The build logs each stage to stderr and ends by printing the database path and a launch command:

```text
Database: /path/to/output-next/wotlk.sqlite
WOTLK_MCP_DB='/path/to/output-next/wotlk.sqlite' node '/path/to/wotlk-mcp/dist/index.mjs'
```

`vp run build --help` prints the usage and prerequisites.

## Run the server against your build

Register the built server with your client, using the absolute paths the build printed. For Claude Code, from the repository root:

```sh
claude mcp add --env WOTLK_MCP_DB="$PWD/output/wotlk.sqlite" --transport stdio wotlk -- node "$PWD/dist/index.mjs"
```

For clients configured with an `mcpServers` JSON file:

```json
{
  "mcpServers": {
    "wotlk": {
      "command": "node",
      "args": ["/path/to/wotlk-mcp/dist/index.mjs"],
      "env": { "WOTLK_MCP_DB": "/path/to/wotlk-mcp/output/wotlk.sqlite" }
    }
  }
}
```

With `WOTLK_MCP_DB` set, the server makes no network requests.

## Build stages

| Stage | What it does |
| --- | --- |
| acquire and verify inputs | Downloads and verifies every source. See [Sources](#sources). |
| offsets | Creates the database and loads the curated Offsets from `data/offsets/`. |
| codex | Imports the Lua API Records. |
| client data | Imports every build-12340 DBC file into `dbc_` tables using WoWDBDefs layouts. |
| interface | Imports FrameXML, GlueXML, and Blizzard addon files into `ui_` tables. |
| world | Runs the AzerothCore world importer against a fresh MySQL container and copies the world tables into `world_` tables. |
| native | Links Lua functions and widget methods to their native registrations in the client. |
| world links, loot links, client and spawn links | Derives Links from stored keys. |
| world enums, spell enums and foreign keys | Loads enum and flag names from the AzerothCore headers. |
| fidelity report | Writes `fidelity.json`. |
| provenance and notices | Fills the `source` table and writes `NOTICE.md`. |
| compressed reference | Writes `wotlk.sqlite.br` and `build-report.json`. |
| server and SQL worker | Runs `vp pack` to compile `dist/`. |

## Outputs

| Path | Contents |
| --- | --- |
| `wotlk.sqlite` | The reference database. Point `WOTLK_MCP_DB` at this file. |
| `wotlk.sqlite.br` | The Brotli-compressed database, as published in a release. |
| `NOTICE.md` | Sources, pinned revisions, licences, and attribution. |
| `fidelity.json` | Discrepancies between sources, such as item-set members missing from World Data. Reported only; source data is not changed. |
| `build-report.json` | Stage timings, database sizes, and the compressed SHA-256. |
| `inputs/` | Downloaded and verified sources. |
| `world/` | World import working files, including `updater.log`. |

`inputs/` contains Blizzard-derived files. Handle it under the same rights as the client inputs; see [Rights](#rights).

If the compressed database exceeds 250 MB, the build still succeeds but warns `Compressed asset exceeds 250 MB; an explicit scope decision is required before publication.` The release gate rejects such an asset. Do not drop required source content to fit.

## Sources

The build always resolves the latest upstream sources, pins each to an exact revision, and records it in the `source` table and `meta.input_pins`. Any missing provenance, failed hash check, or incompatible layout stops the build. It never falls back to older inputs or skips a domain.

GitHub API requests use `GITHUB_TOKEN`, or `GH_TOKEN` when it is unset. CI supplies this token to avoid the shared runner IP's unauthenticated rate limit. Archive downloads do not receive the token.

| Source | Provides | How it is pinned and verified |
| --- | --- | --- |
| Client inputs | DBC files, Interface source, native registration dump | Release `client-inputs-12340-engb-1` of this repository, downloaded with `gh`. `build/sources/verify-client-inputs.py` checks the bundle and manifest hashes, permitted paths, and every file hash before extraction. |
| [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) | DBC layouts for build 12340 | `master` resolved to a commit; the archive is downloaded and hashed once. |
| [AzerothCore](https://github.com/azerothcore/azerothcore-wotlk) | World Data, enum headers | The `acore/ac-wotlk-db-import:master` image resolved to a digest. Its build provenance must name the AzerothCore repository and a commit, and that commit's source archive supplies the SQL and headers. Custom and module SQL is rejected. |
| [Codex](https://github.com/Shard-MW/milkyway-codex) | Lua API data | `main` resolved to a commit and checked out detached. The eight consumed data files are hashed, then evaluated in a digest-pinned `node:24-alpine` container with no network, a read-only filesystem, no capabilities, and a 60-second limit. |
| Offsets | Native addresses | The JSON in `data/offsets/` at the current Git commit. |

The published importer image can lag AzerothCore's branch head, so World Data matches the importer, not the newest commit.

### Interpretation rules

- **Records are not merged.** AzerothCore `*_dbc` override tables stay in `world_` tables and do not change Client Data Records.
- **Links come only from stored keys.** Names, scripts, and text never create a Link, and both ends must be existing Records. Missing or cyclic loot references abort the build with the source row.
- **Loot and spawn notes are raw values.** Chances, groups, and spawn counts repeat the stored rows; they are not effective drop probabilities or inferred zones.
- **Enum decoding is additive.** `get` shows decoded names after the raw value. Unknown values, flag bits, and the sentinel `-1` are left undecoded.
- **Codex addresses are claims.** Codex `memoryAddress` values are kept as data, never used as evidence for native Links. `implemented by` Links require a curated Offset with the same address.
- **Source rows are kept exactly.** A value SQLite cannot store exactly, such as a negative zero, fails the build with the table, column, and value.

## Rights

The database is not MIT licensed. It combines Blizzard-derived client data, AzerothCore data (GPL-2.0-or-later), WoWDBDefs (CC BY-SA 4.0, which requires attribution and share-alike), and Codex data, which has no declared licence. The project owner accepts the redistribution risk for the Blizzard-derived and Codex material; that acceptance is not a licence grant. `NOTICE.md` and the `source` table record the details for each build.

The client inputs are an enGB extraction of build 12340, used as an English stand-in for enUS. Byte identity with enUS is not verified, and some locale text can differ. The bundle contains no client executable; `data/client-inputs/manifest.json` records the original executable's fingerprint and the extraction environment.

## Troubleshooting

When a stage fails, the build reports the stage, keeps the partial output directory, and names the World updater log if one was created:

```text
Build failed during world. Partial output retained at /path/to/output. World updater log, if created: /path/to/output/world/updater.log
```

Builds cannot resume. Inspect the partial directory, then build into a new one. Delete the partial directory yourself when you no longer need it.

| Symptom | Check |
| --- | --- |
| `Cannot download … release client-inputs-12340-engb-1 …` | Run `gh auth status` and confirm the account can read this repository's releases. |
| `Cannot resolve image …` or `Invalid provenance for …` | Confirm Docker is running, Buildx is installed, Docker Hub is reachable, and the machine can run linux/amd64 images. A missing provenance attestation cannot be worked around. |
| `Output already exists: …` | Choose a new output directory. |
| A schema, layout, or native-registration error | An upstream source changed incompatibly. Inspect the reported revision and table; do not relax validation or drop data to get past it. |

## Maintain the Offsets

The Offsets are curated JSON files in `data/offsets/`, one per topic. Paths are namespace paths such as `Globals::PlayerName`; topic file names carry no meaning. Validate them after every change:

```sh
vpx scripts/validate-offsets.ts
```

The command prints `Validated N Offset entries in M topics` or the first validation error.

The Zod schema in `build/offsets.ts` is also published as `data/offsets.schema.json`, which VS Code uses for completion through `.vscode/settings.json`. After changing the Zod schema, regenerate it:

```sh
vpx scripts/validate-offsets.ts --schema > data/offsets.schema.json
```
