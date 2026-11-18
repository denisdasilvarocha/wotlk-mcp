# Database and updates

The server reads one SQLite reference database. It does not bundle one: it either opens the file you point it at, or downloads a published database from this repository's GitHub releases and caches it.

## Use a local database

Set `WOTLK_MCP_DB` to the database path in your client's MCP server configuration. From a shell:

```sh
WOTLK_MCP_DB=/path/to/wotlk.sqlite npx -y wotlk-mcp
```

With `WOTLK_MCP_DB` set, the server makes no network requests and ignores the cache. It opens the file at startup and checks its schema. If the file is missing or incompatible, every tool call fails with `invalid WOTLK_MCP_DB: …`; the server does not fall back to a download.

## Download and cache

Without `WOTLK_MCP_DB`, the server starts loading a database as soon as it starts:

1. It lists this repository's releases and picks the newest published release tagged `db-v<major>.<minor>.<patch>` whose major matches the schema major the package accepts. Drafts and prereleases are skipped.
2. It downloads the `wotlk.sqlite.br` asset and checks it against the SHA-256 digest GitHub records for that asset.
3. It decompresses the file and verifies that the embedded schema version exactly matches the release tag before moving it into the cache.

A tool call waits up to 20 seconds for the first download. If the download is still running, the call fails with `reference database downloading (N of M bytes); retry shortly`. Retry the call; the download continues in the background.

The cache lives in a directory per schema major, so package majors installed side by side never remove each other's files:

| Platform         | Cache directory                                                        |
| ---------------- | ---------------------------------------------------------------------- |
| macOS            | `~/Library/Caches/wotlk-mcp/schema-1`                                  |
| Windows          | `%LOCALAPPDATA%\wotlk-mcp\schema-1`                                    |
| Linux and others | `$XDG_CACHE_HOME/wotlk-mcp/schema-1`, or `~/.cache/wotlk-mcp/schema-1` |

At startup the server selects the newest cached database that opens with a compatible schema, and keeps one older usable copy as a fallback. It reads the selection through its own hard link, so an update never changes a file in use. Older databases, partial downloads, and session files from stopped processes are removed once they are more than 24 hours old.

## Updates

A server with a cached database starts immediately and checks for updates in the background:

- It checks at most once every 24 hours, counting failed attempts. Only one server checks at a time; another server that tries at the same moment logs a failed check and carries on.
- A verified update is cached but used only from the next start. The running server keeps its snapshot for the whole session.
- Offline starts use the cache. If the newest cached file is unusable, the server uses the previous one.
- If the newest published release is an older version than the cached one (a rollback), the next start uses that release.
- A download that finishes late does not replace a more recently observed release.

### Package and schema majors

Package major 1 accepts database schema major 1. If a release needs a higher package major, the server writes `newer reference data needs wotlk-mcp@N; update your config` to stderr and appends the same note once to the next tool result. It keeps using the newest compatible database until you upgrade. To upgrade, change the package in your client configuration to `wotlk-mcp@N`, for example `npx -y wotlk-mcp@2`, and restart the client.

## GitHub authentication

Release requests are unauthenticated by default. Set `GITHUB_TOKEN` or `GH_TOKEN` to raise GitHub's rate limit or to read releases from a private repository. The token needs read access to this repository's releases only; keep it out of committed configuration.

## Troubleshooting

| Message | Cause | Action |
| --- | --- | --- |
| `reference database downloading (…); retry shortly` | The first download is still running. | Retry the tool call. |
| `no reference database: download failed (…); retry online or set WOTLK_MCP_DB` | No cached database, and the download failed. | Check network access and GitHub rate limits, set a token, or point `WOTLK_MCP_DB` at a local database. |
| `no compatible published reference release` | No published `db-v1.*` release exists. | Build locally and set `WOTLK_MCP_DB`. |
| `no compatible release; newer reference data needs wotlk-mcp@N` | Only releases for a newer package major exist. | Upgrade to package major `N`. |
| `release asset missing required SHA-256 digest` or `database SHA-256 digest mismatch` | The release asset failed verification. Nothing was cached. | Retry later; report the release if it persists. |
| `invalid WOTLK_MCP_DB: …` | The override path is missing or not a compatible database. | Fix the path or rebuild the database. |
| `reference update check failed: …` on stderr | A background update check failed. | No action needed; the cached database stays in use and the next check runs after 24 hours. |
