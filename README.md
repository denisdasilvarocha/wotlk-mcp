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

Install [Vite+](https://viteplus.dev/guide/#install-vp-globally), with `vp` and `vpx` available on your PATH, and Node.js 24.15.0 or newer with npm. Then install dependencies:

```bash
vp install
```

For a local Offsets-only reference and stdio process, run:

```bash
vp run build
vp run init:reference reference.sqlite
WOTLK_MCP_DB="$PWD/reference.sqlite" node dist/index.mjs
```

Connect an MCP client to that process; it is not an interactive shell. This local reference is not the production database.

To add the verified Interface source to an existing reference, use the extracted inputs and independently trusted manifest digest:

```bash
vp run import:interface reference.sqlite /path/to/client-inputs MANIFEST_SHA256
```

Run the full test suite:

```bash
vp test
```

The full suite needs Python 3, `tar`, a POSIX shell and standard Unix utilities, plus npm and network access for the clean package-install test. Tests create symlinks and run packed consumer contracts; they do not run the real complete build. The synthetic MPQ archive test is skipped when no StormLib shared library is found at `/opt/homebrew/lib/libstorm.dylib` or `/usr/lib/libstorm.so`; set `STORMLIB_TEST_LIBRARY` to its absolute path to run it. That test also needs CMake and a C++ compiler.

The [cache compatibility workflow](.github/workflows/cache-compatibility.yml) runs a selected set of tests on Windows, macOS and Linux with Node 24.15.0 and 26; it is not the full suite or the separate release acceptance matrix.

Validate the curated Offsets JSON and unique paths:

```bash
vp run validate:offsets
```

The 13 documents in `data/offsets` use the schema in `data/offsets.schema.json`. After changing the Zod schema in `scripts/offsets.ts`, regenerate it with `vpx scripts/validate-offsets.ts --schema > data/offsets.schema.json`. Topic names have no semantic significance; paths omit only `WoWOffsets::`. The migration test compares against the original C++ declarations preserved in `tests/fixtures/original-offsets.txt` from commit `34504ad`. See [address conventions](docs/offsets/address-conventions.md) and [Windows x86 provenance](docs/offsets/windows-x86.md) before using an entry. Release acceptance runs the actual packed executable against a candidate SQLite database:

```bash
vpx scripts/acceptance.ts /path/to/wotlk-mcp.tgz /path/to/candidate.sqlite tests/fixtures/acceptance.json
```

The cited fixtures include **unapproved** World Data candidates. The command fails until a maintainer reviews the exact assertions in `docs/world-data-facts.md` and records approval in `data/world-acceptance-approval.json`: `status` must be `approved`, with `reviewer`, ISO `date`, a URL `record` to the durable review, `fixtures_sha256` for the exact fixture file, and `world_cases` listing every approved World case ID. Changes to any fixture require a new approval digest. This is not a publication command. A local candidate is not a substitute for the verified draft asset and six-cell release matrix.

Build the executable:

```bash
vp pack
```

For the complete reference, client-input extraction, source imports, native registration evidence and World Data reproduction, see the [build and import guide](docs/build.md).

### Repository layout

- `src/`: runtime server and query code; `src/schema.ts` is shared with build scripts.
- `scripts/`: reference construction, imports, validation and release tooling.
- `tests/`: tests and fixtures, including packed consumer contracts.
- `data/`: curated inputs, source pins and approval records.
- `world/`: World Data reproduction assets and evidence.
- `docs/`: maintainer guides, domain decisions and provenance.

## Releasing the npm package

For database candidate preparation, gated publication and rollback, see the [database release guide](docs/releases.md).

Package releases are independent of `db-v<semver>` database releases. Set the package version explicitly in `package.json` and tag the same commit `v<version>`. The tag starts `.github/workflows/package-release.yml`. Its guard requires a published, non-prerelease database of the accepted schema major, downloads and verifies its GitHub SHA-256 digest, and checks the database's schema metadata before publishing. It also rejects an already published package version and a schema-major change within an existing package major. Keep old immutable database releases available for older package majors; data-only updates do not require npm releases.

`src/schema.ts` hard-codes the accepted schema major and `wotlkSchemaMajor` in the package metadata records it for future release comparisons. Update both together. A schema-major change or breaking tool-contract change requires a new package major; review tool-contract changes explicitly before tagging. Publish the compatible database first. Never delete old database releases as part of a package release.

For #52, the owner must first ensure the unscoped `wotlk-mcp` package exists and is under their control: npm's [trust command](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires an existing package. If necessary, npm documents that staging a new package creates a public placeholder; this bootstrap is a separate owner authorization, not performed by this workflow. In npm package settings configure GitHub Actions trusted publishing with organization/user `denisdasilvarocha`, repository `wotlk-mcp`, workflow filename `package-release.yml`, no environment, and **Allow npm publish**. Do not grant dist-tag management. Configure it only when ready: npm expires an unused new trust configuration after two days. The repository and package must be public for automatic provenance. The GitHub-hosted workflow uses npm CLI 11.5.1 or newer, `id-token: write`, and no stored npm token. The owner should restrict token publishing after OIDC works. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

If npm publication succeeds but GitHub release creation fails, the package version cannot be published again; create the missing GitHub release for the existing tag after inspecting the failed job rather than retrying publication.
