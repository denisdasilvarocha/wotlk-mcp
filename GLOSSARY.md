# wotlk-mcp

A read-only reference that answers questions about the World of Warcraft 3.3.5a client (build 12340) for people building against private servers.

## Language

### Target

**Target Build**:
The one client the reference describes: World of Warcraft 3.3.5a, build 12340, enUS locale, Windows x86.
_Avoid_: version, patch, WotLK (on its own)

**Blizzlike**:
Content matching the original 3.3.5a game as shipped, with no realm-specific customisation.
_Avoid_: retail, vanilla, stock

### Domains

**Domain**:
One of the three bodies of knowledge the reference covers: Lua API, Game Data and Offsets.
_Avoid_: dataset, category, module

**Lua API**:
The client's scripting surface as addons see it: global functions, events, widget types and methods, enums and constants, CVars, slash commands, and the FrameXML interface source.
_Avoid_: WoW API, addon API

**Game Data**:
The umbrella for game content records. It is made up of exactly Client Data and World Data.
_Avoid_: game world data, DB data

**Client Data**:
Game Data shipped inside the client in its DBC files, such as spells, item sets, talents, maps, areas and factions.
_Avoid_: DBC data, client DB

**World Data**:
Game Data held in an emulator's world database, such as creatures, items, quests, loot, spawns and vendors, taken as the Blizzlike baseline.
_Avoid_: server data, world DB, emulator data

**Offsets**:
The catalog of native addresses, object-field offsets and vtable slots for the Target Build.
_Avoid_: addresses, memory map, pointers
