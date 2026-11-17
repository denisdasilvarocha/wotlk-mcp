# Wotlk MCP

[![CI](https://img.shields.io/github/actions/workflow/status/denisdasilvarocha/wotlk-mcp/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&labelColor=0D1117&color=238636)](https://github.com/denisdasilvarocha/wotlk-mcp/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/wotlk-mcp?style=for-the-badge&logo=npm&logoColor=white&labelColor=0D1117&color=CB3837)](https://www.npmjs.com/package/wotlk-mcp) [![Monthly npm downloads](https://img.shields.io/npm/dm/wotlk-mcp?style=for-the-badge&logo=npm&logoColor=white&labelColor=0D1117&color=BF8700)](https://www.npmjs.com/package/wotlk-mcp) [![License](https://img.shields.io/github/license/denisdasilvarocha/wotlk-mcp?style=for-the-badge&labelColor=0D1117&color=D29922)](LICENSE)

Read-only MCP reference for World of Warcraft 3.3.5a build 12340.

It gives your AI agent exact client data, Lua API, Interface source, and offsets instead of recalled ones. The server never connects to the game client or a game server.

## Install

Requires [Node.js](https://nodejs.org/) 24.15.0 or newer.

> [!NOTE]
> On first use, the server downloads the reference database.

| Client | Command |
| --- | --- |
| [Claude Code](https://code.claude.com/docs/en/mcp) | `claude mcp add --transport stdio --scope user wotlk -- npx -y wotlk-mcp` |
| [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | `codex mcp add wotlk -- npx -y wotlk-mcp` |
| [Cursor](https://cursor.com/docs/mcp) | `agent mcp add wotlk -- npx -y wotlk-mcp` |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) | `copilot mcp add wotlk -- npx -y wotlk-mcp` |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/reference/cli-commands#hermes-mcp) | `hermes mcp add wotlk --command npx --args -y wotlk-mcp` |
| [OpenClaw](https://docs.openclaw.ai/cli/mcp/registry) | `openclaw mcp add wotlk --command npx --arg -y --arg wotlk-mcp` |
| [OpenCode](https://dev.opencode.ai/v2/docs/mcp-servers/) | `opencode mcp add wotlk -- npx -y wotlk-mcp` |
| [Pi](https://pi.dev/docs/latest/mcp) | `pi mcp add wotlk -- npx -y wotlk-mcp` |
| [Oh My Pi](https://github.com/c1357/oh-my-pi/blob/main/docs/mcp-config.md) | Run `/mcp add`, choose stdio, command `npx`, arguments `-y wotlk-mcp` |

For other clients, add the server to your MCP configuration:

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

## Usage

Ask your agent in plain language. The server tells it what it covers and how to use its tools.

```text
Where does Thunderfury come from?
Which NPC starts the quest A Threat Within, and who completes it?
What arguments does UnitHealth take, and where is it implemented in the client?
Show me the ChatFrame_OnEvent source in FrameXML.
```

> [!WARNING]
> If a tool call reports **reference database downloading**, the first download is still running. Ask again in a few seconds.

## Tools

| Tool | Description |
| --- | --- |
| [search](docs/tools.md#search) | Find IDs by name or text, such as `Thunderfury` → `item:19019`. |
| [get](docs/tools.md#get) | Read full Records, or a window of Interface source lines. |
| [related](docs/tools.md#related) | Follow Links: loot sources, quest givers, rewards, vendors, trainers, spawns. |
| [sql](docs/tools.md#sql) | Run read-only SQLite queries for counts, filters, and joins. |

### Data

| Domain | Source | Includes |
| --- | --- | --- |
| **Client data** | 245 client DBC tables | `spells`, `talents`, `item sets`, `skill lines`, `maps`, `areas`, `factions`, `classes`, `races`, `achievements`, `titles`, `currencies`, `glyphs`, `gems`, `enchantments`, `taxi paths`, `vehicles`, `holidays`, `dungeons`, `emotes`, `sounds`, `combat ratings` |
| **World data** | AzerothCore world database | `creatures`, `items`, `quests`, `game objects`, `loot`, `vendors`, `trainers`, `spawns`, `quest givers`, `quest enders`, `gossip`, `NPC text`, `conditions`, `game events`, `spawn pools`, `instances`, `graveyards`, `character creation` |
| **Lua API** | Codex data, native client registrations | `functions`, `events`, `widgets`, `widget methods`, `CVars`, `argument types`, `combat log events`, `secure templates`, `slash commands` |
| **Interface source** | FrameXML, GlueXML, Blizzard addons | `source files`, `source lines` |
| **Offsets** | Curated JSON in `data/offsets/` | `client addresses`, `lua method links` |

The reference covers only the 3.3.5a build 12340 Windows x86 client, not retail, Classic, or other expansions.

## Documentation

- [Tool reference](docs/tools.md): parameters, output, IDs, relations, and SQL tables for each tool.
- [Database and updates](docs/database.md): download, verification, cache, updates, offline use, and error messages.
- [Development](docs/development.md): set up the repository, run checks, and test changes.
- [Build the reference](docs/build.md): build the database from source and run the server against it.
- [Release operations](docs/releases.md): database and npm releases, acceptance, and rollback.

## Contributing

- [Contributing guide](.github/CONTRIBUTING.md): setup, checks, and pull request conventions.
- [Code of Conduct](.github/CODE_OF_CONDUCT.md): expected behavior in the project.
- [Issues](https://github.com/denisdasilvarocha/wotlk-mcp/issues/new/choose): report bugs and request features.

## License

[MIT](LICENSE)
