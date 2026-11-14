# wotlk-mcp

A read-only MCP reference for World of Warcraft 3.3.5a build 12340.

> **Release status:** This repository is private. The npm package and production database have not been published; the examples below describe the intended public installation and do not currently provide a public live service. The separately authorized client-inputs release is private. World Data acceptance approval is still deferred.

## Build and run locally

From the repository root, you need Node.js **24.15.0 or newer**, [Vite+](https://viteplus.dev/guide/#install-vp-globally) (`vp` and `vpx`), Git, Python 3, `tar`, the GitHub CLI (`gh`) authenticated with release-read access to the private client-inputs release, and Docker with Buildx and linux/amd64 execution. Allow disk space for sources, MySQL and the output.

```sh
vp install
vp run build
```

The build acquires its inputs and builds the complete reference and server; no local game extraction or manual imports are needed. It creates `output/`, which must not already exist. For later builds use a fresh directory, for example `vp run build ./output-next`. See the [build guide](docs/build.md) for outputs, source selection and troubleshooting.

Register the built stdio server with Claude Code from the repository root:

```sh
claude mcp add --env WOTLK_MCP_DB="$PWD/output/wotlk.sqlite" --transport stdio wotlk -- node "$PWD/dist/index.mjs"
```

This registers a local process, not an HTTP service. Other MCP clients can launch `node dist/index.mjs` with `WOTLK_MCP_DB` set to the absolute database path.

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

## Published-package installation — not available yet

The following examples are for after the npm package and compatible database are published. Published-package users will need Node.js 24.15.0 or newer and npm, not the Docker and source-build prerequisites above. These clients launch a local stdio process, not an HTTP service.

### Claude Code

On macOS or Linux, using the [Claude Code MCP command](https://code.claude.com/docs/en/mcp):

```sh
claude mcp add --transport stdio wotlk -- npx -y wotlk-mcp@1
```

On Windows:

```text
claude mcp add --transport stdio wotlk -- cmd /d /s /c "npx -y wotlk-mcp@1"
```

### Codex

In `~/.codex/config.toml` or a trusted project's `.codex/config.toml`, following the [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp#stdio-servers):

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

On Windows use `"command": "cmd"` and `"args": ["/d", "/s", "/c", "npx -y wotlk-mcp@1"]`. Merge the entry into an existing config. These examples pin the package major; upgrading to a new major is deliberate.

## Development

| Command                | Purpose                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `vp run build`         | Acquire sources and build the complete database and server. |
| `vp pack`              | Compile the server and SQL worker only.                     |
| `vp run dev`           | Watch server compilation; does not refresh data.            |
| `vp test` / `vp check` | Run tests / project checks.                                 |
| `vp pm pack`           | Create the npm tarball.                                     |

The full suite needs Python 3, `tar`, a POSIX shell, standard Unix utilities, npm and network access for the clean package-install test. The [cache compatibility workflow](.github/workflows/cache-compatibility.yml) runs selected tests on Windows, macOS and Linux with Node 24.15.0 and 26, not the full suite or release acceptance matrix. See [build maintenance](docs/build.md#developer-maintenance) and [release operations](docs/releases.md) for validation and publication.

### Repository layout

- `src/`: runtime and shared schema.
- `build/`: reference construction.
- `scripts/`: maintenance and release entry points.
- `data/`: curated inputs and evidence.
- `tests/`: behavioral tests and fixtures.
- `docs/`: guides and provenance.

## Rights and provenance

The independently authored package code is [MIT licensed](LICENSE). The database contains mixed-rights material and is **not** blanket MIT: consult the `source` table and the `NOTICE.md` accompanying each database release. The owner's verified enGB extraction is an accepted English stand-in for the enUS target, not proof of full enUS byte identity. The owner accepts the risks of redistributing Blizzard-derived material and using the unlicensed Codex source; acceptance is not permission or a licence grant. See the private [client-inputs release notice](https://github.com/denisdasilvarocha/wotlk-mcp/releases/tag/client-inputs-12340-engb-1) and [database releases](https://github.com/denisdasilvarocha/wotlk-mcp/releases) when available.
