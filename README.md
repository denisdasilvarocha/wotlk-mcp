# wotlk-mcp

Read-only MCP reference for World of Warcraft 3.3.5a build 12340.

wotlk-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives your AI agent exact facts about the 3.3.5a client instead of recalled ones. Use it when you build private servers, addons, or client tools.

- **Game Data**: spells, talents, achievements, maps, and factions from the client DBC files; creatures, items, quests, loot, vendors, trainers, and spawns from the AzerothCore world database.
- **Lua API and Interface source**: global functions, events, widgets and methods, CVars, combat log events, secure templates, slash commands, and every FrameXML, GlueXML, and Blizzard addon source line.
- **Offsets**: native client addresses, linked to the Lua methods they implement.

## Requirements

- [Node.js](https://nodejs.org/) 24.15.0 or newer, which includes `npx`
- Network access on first use, to download the reference database (about 160 MB, about 2.2 GB on disk)

## Install

Run the command for your client:

<details>
<summary>Codex</summary>

```bash
codex mcp add wotlk -- npx -y wotlk-mcp
```

See the [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

</details>

<details>
<summary>Claude Code</summary>

```bash
claude mcp add --transport stdio --scope user wotlk -- npx -y wotlk-mcp
```

See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

</details>

<details>
<summary>Cursor</summary>

The Cursor CLI shares its MCP configuration with the editor:

```bash
agent mcp add wotlk -- npx -y wotlk-mcp
```

See the [Cursor MCP documentation](https://cursor.com/docs/mcp).

</details>

<details>
<summary>Hermes Agent</summary>

```bash
hermes mcp add wotlk --command npx --args -y wotlk-mcp
```

Follow the prompts to select tools and save the server. See the [Hermes MCP CLI reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands#hermes-mcp).

</details>

<details>
<summary>OpenClaw</summary>

Stop the local gateway before registering the server, then start it again afterward:

```bash
openclaw mcp add wotlk --command npx --arg -y --arg wotlk-mcp
```

See the [OpenClaw MCP registry reference](https://docs.openclaw.ai/cli/mcp/registry).

</details>

<details>
<summary>OpenCode</summary>

In OpenCode v2, run this from your project:

```bash
opencode mcp add wotlk -- npx -y wotlk-mcp
```

Add `--global` before `--` to make the server available in every project. In OpenCode v1, run `opencode mcp add` and follow the prompts for a local server named `wotlk` with the command `npx -y wotlk-mcp`. See the [OpenCode v1 CLI reference](https://opencode.ai/docs/cli/#mcp) and [v2 MCP documentation](https://dev.opencode.ai/v2/docs/mcp-servers/).

</details>

<details>
<summary>Pi</summary>

Pi [0.99.0](https://pi.dev/changelog/releases/0.99.0) introduced built-in MCP support. With that version or later, run:

```bash
pi mcp add wotlk -- npx -y wotlk-mcp
```

See the [Pi MCP documentation](https://pi.dev/docs/latest/mcp).

</details>

<details>
<summary>Oh My Pi (OMP)</summary>

Start `omp` and run `/mcp add` in the session. In the setup wizard, name the server `wotlk`, choose stdio, enter `npx` as the command and `-y wotlk-mcp` as the arguments, and select your preferred scope. See the [OMP MCP configuration guide](https://github.com/c1357/oh-my-pi/blob/main/docs/mcp-config.md).

</details>

<details>
<summary>GitHub Copilot CLI</summary>

```bash
copilot mcp add wotlk -- npx -y wotlk-mcp
```

See the [GitHub Copilot CLI MCP guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

</details>

<details>
<summary>Other clients</summary>

Configure the client to start `npx` with the arguments `-y` and `wotlk-mcp`. Some clients accept a JSON configuration like this:

```json
{
  "mcpServers": {
    "wotlk": {
      "command": "npx",
      "args": ["-y", "wotlk-mcp"]
    }
  }
}
```

Add the server to any existing configuration without replacing your other servers. Configuration formats and file locations differ by client. See the [npm `npx` reference](https://docs.npmjs.com/cli/v11/commands/npx/).

</details>

On first use, the server downloads the reference database from this repository's GitHub releases, verifies it, and caches it. If a tool call reports that the database is still downloading, ask again in a few seconds.

## Usage

Ask your agent about the game in plain language. The server tells the agent what it covers and how to use its tools, so no special prompt is needed. For example:

- "Where does Thunderfury come from?"
- "Which NPC starts the quest A Threat Within, and who completes it?"
- "What arguments does `UnitHealth` take, and where is it implemented in the client?"
- "Show me the `ChatFrame_OnEvent` source in FrameXML."

Behind the scenes, the agent chains four read-only tools:

| Tool      | Use                                                                           |
| --------- | ----------------------------------------------------------------------------- |
| `search`  | Find IDs by name or text, such as `Thunderfury` → `item:19019`.               |
| `get`     | Read full Records, or a window of Interface source lines.                     |
| `related` | Follow Links: loot sources, quest givers, rewards, vendors, trainers, spawns. |
| `sql`     | Run read-only SQLite queries for counts, filters, and joins.                  |

For example, `related` on Thunderfury returns:

```text
casts spell:21992 (spellid_1, trigger=2)
rewarded by quest:7787 (RewardItem1 quantity=1)
1–2 of 2; end
```

See the [tool reference](docs/tools.md) for parameters, ID kinds, relations, and SQL tables.

The server never connects to the game client or a game server, and it never reads process memory.

## Configuration

Both variables are optional. Set them in your client's MCP server configuration.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WOTLK_MCP_DB` | Download from GitHub releases | Path to a local reference database. Disables all network access. |
| `GITHUB_TOKEN` or `GH_TOKEN` | Unauthenticated | GitHub token for release requests, if you hit GitHub's rate limit. |

See [Database and updates](docs/database.md) for the cache location, updates, offline use, and error messages.

## Documentation

- [Tool reference](docs/tools.md): what each tool accepts and returns.
- [Database and updates](docs/database.md): how the server finds, verifies, caches, and updates its database.
- [Development](docs/development.md): set up the repository, run checks, and test changes.
- [Build the reference](docs/build.md): build the database from source and run the server against it.
- [Release operations](docs/releases.md): database and npm releases, acceptance, and rollback.

## License

MIT
