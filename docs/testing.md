# Test a local Wotlk MCP build

Give this file to your agent as a prompt, for example `@docs/testing.md`.

## 1. Build and configure the harness

If the user confirms they restarted after setup, go to [Run the questions after restart](#2-run-the-questions-after-restart). Otherwise:

1. From the repository root, run `vpr build ./output-testing`. If that directory exists, use a new one. See [build prerequisites](build.md#before-you-begin) if the build cannot start.
2. Add `wotlk` to the active harness’s project-level MCP config in this repo. For Oh My Pi, use `.omp/mcp.json`. Leave global settings and other servers untouched. Set the stdio command to `node`, pass the absolute path to `dist/index.mjs`, and set `WOTLK_MCP_DB` to the absolute path of the `wotlk.sqlite` the build printed. Do not use the published package or a downloaded snapshot. If the harness has no project-level MCP config, report setup as blocked.
3. Tell the user: “Restart the harness, then send `@docs/testing.md I restarted the harness. Run the questions.`” Stop and wait for confirmation.

## 2. Run the questions after restart

Confirm the restarted harness loads `wotlk` from this project’s config and points to the local build. Use its `sql` tool to record the schema version and build commit:

```sql
SELECT key, value FROM meta WHERE key IN ('schema_version', 'build_commit')
```

If the configuration or MCP query cannot be verified, report the run as blocked and stop. Otherwise answer each question using only the `wotlk` MCP tools. Do not use the web, direct SQLite access, memory, or the answer key. Keep the case number, tool calls and results, and your final answer in the harness transcript. If the tools do not establish a fact, say so.

## Questions

Run all 100 cases in order. Keep the numbers when answering.

### Quests

1. For quest 783, A Threat Within, which faction gains reputation and how much?
2. Who starts and ends A Threat Within, quest 783? Please include their IDs.
3. What are the quest level and minimum required level of Kobold Camp Cleanup, quest 7?
4. Which NPC both starts and ends Kobold Camp Cleanup (quest 7), and what is the NPC's ID?
5. What are the five weapon reward choices and their item IDs for Brotherhood of Thieves, quest 18?
6. How many Red Burlap Bandanas are required for Brotherhood of Thieves, quest 18, and what is the item ID?
7. Who gives and receives the quest Eagan Peltskinner, ID 5261? Include both NPC IDs.
8. For Wolves Across the Border, quest 33, what are its two item reward choices and IDs?
9. What item and quantity does quest 33, Wolves Across the Border, ask you to bring back? Include the item ID.
10. What are the reward choices and item IDs for Bounty on Garrick Padfoot, quest 6?
11. Which NPC starts and ends Skirmish at Echo Ridge (quest 21), and what is their ID?
12. Which three items can you choose from as a reward for quest 21, Skirmish at Echo Ridge? Give the item IDs.
13. Which NPCs start and end Further Concerns, quest 35, and what are their IDs?
14. Which game object ends Find the Lost Guards, quest 37, and what is its ID?
15. Which game objects start and end Discover Rolf's Fate, quest 45, and what are their IDs?
16. In Gold Dust Exchange, quest 47, which item must be collected and which item is the reward? Give both IDs and the required quantity.
17. For Kobold Candles, quest 60, what quantity of which item is required, and what item is rewarded? Include IDs.
18. Who ends Report to Gryan Stoutmantle, quest 109, and what is that NPC's ID?
19. Which object starts Wanted: Hogger (quest 176), which NPC ends it, and what are their IDs?
20. How do the reputation rewards for A Threat Within (quest 783) and Kobold Camp Cleanup (quest 7) compare, including faction IDs?
21. For Frostmane Hold, quest 287, which two factions receive reputation and how much does each receive? Include their IDs.
22. What are the quest levels and minimum required levels of Hellscream's Vigil (quest 11585) and Enlistment Day (quest 11672)?
23. Who starts and ends Enlistment Day, quest 11672? Include both IDs.
24. What are the two weapon reward choices and item IDs for The Light of Dawn, quest 12801?
25. What reputation does The Light of Dawn, quest 12801, award, and to which faction ID?

### Items and loot

26. What are the item ID, quality, item level, and weapon type of Thunderfury, Blessed Blade of the Windseeker?
27. Which quest rewards Thunderfury, Blessed Blade of the Windseeker, and what are both IDs?
28. Which boss drops Bindings of the Windseeker item 18563, and what is the boss's ID?
29. Where do I find Bindings of the Windseeker item 18564, and what is the source's ID?
30. Which creature drops the Eye of Sulfuras, and what are the item and creature IDs?
31. Who drops Brutality Blade, and what are their IDs?
32. Which boss drops Cloak of the Shrouded Mists, and what are the item and creature IDs?
33. Which boss drops Ashkandi, Greatsword of the Brotherhood, and what are the IDs?
34. What creature drops Chromatically Tempered Sword, and what are the two IDs?
35. Which creature drops Eye of Magtheridon, and what are its creature ID and the trinket’s item ID?
36. Which boss drops Thori'dal, the Stars' Fury, and what are their IDs?
37. Who drops the main-hand Warglaive of Azzinoth, item 32837, and what is their ID?
38. Where does the off-hand Warglaive of Azzinoth, item 32838, drop, and what is the creature ID?
39. Who drops Last Laugh in Wrath, and what are its item ID and the boss's creature ID?
40. Which boss drops Sash of Mortal Desire, and what are their IDs?
41. Where can I get Tunic of Prejudice as a drop, and what are the boss and item IDs?
42. Which creature drops Glorenzelg, High-Blade of the Silver Hand, and what are both IDs?
43. Which specific chest contains Damnation, and what are the chest and item IDs?
44. What chest can contain Sword of Justice, and what are their IDs?

### Item comparisons

45. How do Shadowmourne and Shadow's Edge compare in item level and quality, and what are their item IDs?
46. How do the main-hand and off-hand Warglaives of Azzinoth compare in item level and quality? Give their IDs.
47. Which has the higher item level, Ashkandi or Chromatically Tempered Sword, and what are their IDs and levels?
48. What are the item levels, armor slots, and IDs of Sash of Mortal Desire and Tunic of Prejudice?
49. What are the item levels and weapon types of Damnation and Sword of Justice, including their IDs?
50. What are the quality, item level, and item IDs of Thunderfury and Thori'dal?

### Vendors

51. Does Tharynn Bouden (creature:66) sell Recipe: Longjaw Mud Snapper, and what is the recipe's item ID?
52. Which item ID identifies the Pattern: Blue Linen Vest sold by Tharynn Bouden (creature:66)?
53. Does Corina Steele (creature:54) sell a Gladius? Give the item's ID.
54. What is the item ID of the Walking Stick sold by Corina Steele (creature:54)?
55. Does Kendor Kabonka (creature:340) stock Recipe: Redridge Goulash? Include its item ID.
56. What is the item ID of Recipe: Westfall Stew sold by Kendor Kabonka (creature:340)?
57. Is Kaita Deepforge (creature:5512) a vendor for Mining Pick? Include its item ID.
58. What is the item ID of Plans: Hardened Iron Shortsword sold by Kaita Deepforge (creature:5512)?
59. What is the item ID for the Brigandine Helm in Osric Strang's (creature:1323) inventory?
60. Does Osric Strang (creature:1323) sell Crested Heater Shield, and what is its ID?
61. What is the item ID of the Heavy Silken Thread sold by Edna Mullby (creature:1286)?
62. Does Xandar Goodbeard (creature:1685) sell Recipe: Rage Potion? Give its ID.
63. Do both Tharynn Bouden (creature:66) and Kaita Deepforge (creature:5512) sell Weak Flux? Give its item ID.
64. Do both Edna Mullby (creature:1286) and Kaita Deepforge (creature:5512) stock Coal? Identify the item.
65. Which creature sells Recipe: Holy Protection Potion, Xandar Goodbeard (creature:1685) or Kendor Kabonka (creature:340)? Include the item's ID.

### Trainers

66. Which vendor sells Mining Pick, and which teaches Smelt Silver: Kaita Deepforge (creature:5512) or Gelman Stonehand (creature:5513)? Give the item and spell IDs.
67. Which spells named Smelt Bronze and Smelt Iron does Gelman Stonehand (creature:5513) teach? Give their IDs.
68. What are the IDs of the Lesser Healing Potion and Lesser Mana Potion spells taught by Lilyssia Nightbreeze (creature:5499)?
69. Does Theridran (creature:5505) teach Rejuvenation and Entangling Roots? Give their spell IDs.
70. Does Lilyssia Nightbreeze (creature:5499) teach Minor Mana Potion and does Gelman Stonehand (creature:5513) teach Smelt Tin? Give both spell IDs.

### Creature levels and locations

71. What levels are Kaita Deepforge (creature:5512) and Gelman Stonehand (creature:5513), and where can I find them?
72. What levels are Tharynn Bouden (creature:66) and Corina Steele (creature:54), and where can I find them?
73. What are the level ranges and creature categories of Maraudine Mauler (creature:4656) and Rot Hide Mongrel (creature:1675)?
74. What are the levels, elite statuses, and creature categories of Singe (creature:335) and Corporal Keeshan (creature:349)?
75. What levels are Lilyssia Nightbreeze (creature:5499) and Theridran (creature:5505), and where are they found?

### Spells

76. What are the IDs, ranks, and durations of the first two Frostbolt spells?
77. What are the spell IDs and damage-over-time durations of Fireball ranks 1 and 2?
78. What are the ID, school, and duration of Corruption rank 1?
79. What is the ID and duration of the priest spell Shadow Word: Pain at its first rank?
80. What are the IDs and durations of Rejuvenation and Immolate at rank 1?
81. Which spell is ID 17, and how long does its shield last?
82. What spell has ID 118, and how long can its sheep transformation last?
83. Which spells are IDs 10 and 12051, and how do their durations compare?
84. What are the IDs of Arcane Intellect and Frost Armor, and how long do their main buffs last?
85. What is the spell ID for Charge and how long is its stun?

### Achievements

86. What are the IDs of the eight level milestones from Level 10 through Level 80, and what level does each require?
87. Which four exploration achievements are criteria for World Explorer, and what are their IDs?
88. What are the Borean Tundra and Howling Fjord criteria for the Alliance Loremaster of Northrend achievement, including their IDs and quest counts?
89. Which achievement is earned by completing a daily quest on five consecutive days, and what is its ID?
90. What are the IDs and required quest totals for Might of Dragonblight and Fo' Grizzle My Shizzle?
91. What are the achievement IDs and quest requirements for The Empire of Zul'Drak and The Summit of Storm Peaks?
92. What are the achievement IDs and required quest counts for Into the Basin and Icecrown: The Final Goal?
93. What is the ID of Disgracin' The Basin, and what must be done in one battle?
94. Which achievement tracks completing 2,000 quests, and what is its ID?

### Item sets

95. Which item set is ID 201, and how many pieces and bonus thresholds does it have?
96. What are the eight pieces of Arcanist Regalia, and what are the set and item IDs?
97. What are the set IDs and piece counts of Magister's Regalia and Sorcerer's Regalia?
98. What is Netherwind Regalia's item set ID, and at how many pieces are its bonuses awarded?
99. What are Tempest Regalia's set ID, piece count, and bonus thresholds?
100.  What are the ID, number of pieces, and set-bonus threshold for Brewfest Garb?

## Next steps

Once every answer is recorded, use the [Rising Gods answer key](testing-answers.md) to score the run. Mark each case **Pass** if the raw tool results support the expected facts and your answer states them, **Fail** if the data or answer differs, or **Blocked** if you could not run it. Record mismatches without changing the key.
