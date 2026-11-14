# Candidate World Data acceptance facts (#45)

**Status: unapproved.** These are independently researched candidates for maintainer review, not an approved fixture or evidence that a particular AzerothCore import matches Blizzard's servers. No builder output was consulted. Target Build is 3.3.5a/12340 enUS; historical server state can change independently of client build. Only the exact assertions below are proposed; do not infer drop probabilities, loot completeness, spawn counts, SQL row fields, or absence of other Links. The later fixture must be based on explicitly approved assertions and retain their citations and qualifications.

## Sources

- **S1:** [Natalie Mootz, “Midsummer Festival Quest - Shards of Ahune,” 23 June 2008](https://www.engadget.com/2008-06-23-midsummer-festival-quest-shards-of-ahune.html). Contemporary player guide to the live encounter, with contemporary Wowhead links embedding IDs for the chest, shard, NPC and tabards. This predates Wrath, so the 2008 minimum level, currency reward and encounter mechanics are not proposed as 12340 facts.
- **S2:** [Daraia, “Midsummer Fire Festival Guide,” 19 June 2010, Non Repeatable Quests](https://ravenholdtmanor.blogspot.com/2010/06/midsummer-fire-festival-guide.html). Contemporary player guide just before 3.3.5/3.3.5a, links quest 11972 and both tabards by ID, and describes the same quest turn-in and choice. It states levels 75–80, unlike S1; neither level range is proposed as a Target Build fact. The article predates 12340; continuity into that precise build is a maintainer judgment, not proven by publication date.
- **S3:** [Edmond Y. Chang, “Not Just A Walk-Through the Park,” 2008](http://cconlinejournal.org/gaming_issue_2008/Chang_Gaming_as_writing/11.html). Firsthand play account and game stills. It describes accepting “A Threat Within” from Deputy Wilhelm and turning it in to Marshal McBride, plus McBride's subsequent kobold quest. The text misspells the deputy's name “Wilhelm”; do not use that spelling as expected data. It predates Wrath and does not establish numeric IDs or unchanged 12340 behavior.
- **S4:** Blizzard Entertainment, [Wrath of the Lich King Classic: The Way into the Icecrown Citadel is Open!](https://worldofwarcraft.blizzard.com/en-us/news/24013834/wrath-of-the-lich-king-classic-the-way-into-the-icecrown-citadel-is-open), 12 October 2023. Blizzard says that Highlord Darion Mograine offers “The Sacred and the Corrupt” and directly links Shadowmourne as item 49623. This is a first-party account of **Wrath Classic**, not the original 2010 12340 server; it is corroboration and a candidate, not proof of identical original-world state.
- **S5:** [Wowhead WotLK “A Threat Within,” quest 783](https://www.wowhead.com/wotlk/quest=783/a-threat-within), [Deputy Willem, NPC 823](https://www.wowhead.com/wotlk/npc=823/deputy-willem), and [Marshal McBride, NPC 197](https://www.wowhead.com/wotlk/npc=197/marshal-mcbride). Secondary build-family identifier crosswalk, not independent primary historical proof; URLs identify the intended entities. Crosswalks require maintainer verification against historical evidence.

## Proposed exact assertions

Each row is a positive, existential assertion, not an exact result set. `related` inverse names follow the parent specification, not a separate historical source. A gameplay observation is evidence of a relationship, not proof of an underlying explicit foreign key; the latter must be present in the selected World Data before a fixture asserts the Link.

| Case | Expected assertion | Evidence and limits |
| --- | --- | --- |
| W01 | `get(gameobject:187892)` has name `Ice Chest`. | S1 links object 187892 as Ice Chest. Seasonal encounter object, observed 2008; exact 12340 persistence needs review. |
| W02 | `get(item:35723)` has name `Shards of Ahune`. | S1 links item 35723 but mistypes its display text “Shards of Alune”; S1's quest title and S2 identify Ahune. Confirm exact item spelling independently before approval. |
| W03 | `get(creature:25697)` has name `Luma Skymother`. | S1 links NPC 25697 by that name; S2 describes the same NPC in 2010. |
| W04 | `get(quest:11972)` has title `Shards of Ahune`. | S2 directly links quest 11972 with title. |
| W05 | `get(item:35279)` has name `Tabard of Summer Skies`; `get(item:35280)` has name `Tabard of Summer Flames`. | S2 links both item IDs with names; S1 independently links each ID, using shortened labels. |
| W06 | `related(gameobject:187892, drops)` includes `item:35723`; inverse `related(item:35723, dropped by)` includes `gameobject:187892`. | S1 says the Ice Chest can yield the shard; S2 says the shard is found in its Ice Chest. Check explicit source loot keys and 12340 continuity; no chance or exclusivity asserted. |
| W07 | `related(creature:25697, ends)` includes `quest:11972`; inverse `related(quest:11972, ended by)` includes `creature:25697`. | S1 says to complete the shard quest with Luma; S2 directly links quest 11972 and says turn it in to Luma. Check explicit end key. |
| W08 | `related(quest:11972, rewards)` includes both `item:35279` and `item:35280`; inverses `rewarded by` include `quest:11972`. | S2 gives these as a choice, not simultaneous rewards; S1 corroborates. Check explicit reward-choice keys. |
| W09 | `get(quest:783)` title `A Threat Within`; `get(creature:197)` name `Marshal McBride`; `get(creature:823)` name `Deputy Willem`. | S3 independently records quest and characters, with the spelling caveat; S5 supplies IDs and Willem spelling. Pre-Wrath evidence, not a direct 12340 observation. |
| W10 | `related(creature:823, starts)` includes `quest:783`, inverse `started by`; `related(creature:197, ends)` includes `quest:783`, inverse `ended by`. | S3 describes accepting from the deputy and turning in to McBride; S5 provides the identifiers. Check explicit start/end keys and 12340 continuity. |
| W11 | `get(item:49623)` name `Shadowmourne`. | S4 directly links the name and ID, but describes Wrath Classic; original Target Build identity requires separate corroboration or maintainer verification. |

These cases span creature, item, quest and gameobject lookups, and drops, starts, ends and rewards in both directions. They do not certify every Link type or cover numerical probabilities. A mismatch is a fidelity observation to investigate and report, not authorization to alter imported source rows.

## Approval record

**Outstanding:** a maintainer must verify each selected candidate's original 12340 applicability, spelling, identifiers, and explicit-key eligibility, then record their name, date, exact approved case IDs/assertions, source and any exceptions here (or in a durable linked approval record). No approval has been granted by this research.
