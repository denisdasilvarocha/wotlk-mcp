import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, test } from 'vite-plus/test'

test('world keys navigate both ways while SQL retains source evidence', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'world-links-'))
  const database = path.join(dir, 'reference.sqlite')
  const client = new Client({ name: 'world-links-test', version: '1' })
  try {
    execFileSync('vpx', ['scripts/build-reference.ts', database])
    const db = new DatabaseSync(database)
    db.exec(`
      CREATE TABLE world_creature_queststarter (id INTEGER, quest INTEGER);
      CREATE TABLE world_creature_questender (id INTEGER, quest INTEGER);
      CREATE TABLE world_gameobject_queststarter (id INTEGER, quest INTEGER);
      CREATE TABLE world_gameobject_questender (id INTEGER, quest INTEGER);
      CREATE TABLE world_npc_vendor (entry INTEGER, slot INTEGER, item INTEGER, maxcount INTEGER, incrtime INTEGER, ExtendedCost INTEGER);
      CREATE TABLE world_creature_default_trainer (CreatureId INTEGER, TrainerId INTEGER);
      CREATE TABLE world_trainer_spell (TrainerId INTEGER, SpellId INTEGER, MoneyCost INTEGER, ReqSkillLine INTEGER, ReqSkillRank INTEGER, ReqLevel INTEGER);
      CREATE TABLE world_quest_template (ID INTEGER, RewardItem1 INTEGER, RewardAmount1 INTEGER, RewardItem2 INTEGER, RewardAmount2 INTEGER, RewardItem3 INTEGER, RewardAmount3 INTEGER, RewardItem4 INTEGER, RewardAmount4 INTEGER, RewardChoiceItemID1 INTEGER, RewardChoiceItemQuantity1 INTEGER, RewardChoiceItemID2 INTEGER, RewardChoiceItemQuantity2 INTEGER, RewardChoiceItemID3 INTEGER, RewardChoiceItemQuantity3 INTEGER, RewardChoiceItemID4 INTEGER, RewardChoiceItemQuantity4 INTEGER, RewardChoiceItemID5 INTEGER, RewardChoiceItemQuantity5 INTEGER, RewardChoiceItemID6 INTEGER, RewardChoiceItemQuantity6 INTEGER, RewardSpell INTEGER, RewardDisplaySpell INTEGER);
      CREATE TABLE world_item_template (entry INTEGER, spellid_1 INTEGER, spelltrigger_1 INTEGER, spellid_2 INTEGER, spelltrigger_2 INTEGER, spellid_3 INTEGER, spelltrigger_3 INTEGER, spellid_4 INTEGER, spelltrigger_4 INTEGER, spellid_5 INTEGER, spelltrigger_5 INTEGER);
      INSERT INTO world_creature_queststarter VALUES (1, 3), (999, 3);
      INSERT INTO world_creature_questender VALUES (1, 3);
      INSERT INTO world_gameobject_queststarter VALUES (2, 3);
      INSERT INTO world_gameobject_questender VALUES (2, 3);
      INSERT INTO world_npc_vendor VALUES (1, 1, 4, 2, 60, 7), (1, 2, 4, 0, 0, 0);
      INSERT INTO world_creature_default_trainer VALUES (1, 9);
      INSERT INTO world_trainer_spell VALUES (9, 5, 100, 0, 0, 2), (1, 6, 1, 0, 0, 1);
      INSERT INTO world_quest_template VALUES (3, 4, 2, 0, 0, 0, 0, 0, 0, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 4, 6, 5, 6);
      INSERT INTO world_item_template VALUES (4, 5, 0, 0, 0, 0, 0, 0, 0, 5, 1);
      INSERT INTO record VALUES ('creature:1','creature','Creature','world_creature_queststarter',1,'',''), ('gameobject:2','gameobject','Object','world_gameobject_queststarter',1,'',''), ('quest:3','quest','Quest','world_quest_template',1,'',''), ('item:4','item','Item','world_item_template',1,'',''), ('spell:5','spell','Spell','world_item_template',1,'',''), ('spell:6','spell','Spell 6','world_item_template',1,'','');
    `)
    db.close()
    execFileSync('vpx', ['scripts/build-world-links.ts', database])
    execFileSync('vp', ['pm', 'pack', '--pack-destination', dir], { stdio: 'pipe' })
    const archive = readdirSync(dir).find((name) => name.endsWith('.tgz'))
    if (!archive) throw new Error('Package archive not created')
    execFileSync('tar', ['-xzf', path.join(dir, archive), '-C', dir])
    symlinkSync(path.resolve('node_modules'), path.join(dir, 'package/node_modules'), 'dir')
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(dir, 'package/dist/index.mjs')],
        env: { ...process.env, WOTLK_MCP_DB: database }
      })
    )
    async function text(name: string, args: Record<string, unknown>): Promise<string> {
      return JSON.stringify(await client.callTool({ name, arguments: args }))
    }
    await Promise.all(
      [
        ['creature:1', 'starts', 'quest:3'],
        ['quest:3', 'started by', 'creature:1'],
        ['gameobject:2', 'starts', 'quest:3'],
        ['quest:3', 'started by', 'gameobject:2'],
        ['creature:1', 'ends', 'quest:3'],
        ['quest:3', 'ended by', 'creature:1'],
        ['gameobject:2', 'ends', 'quest:3'],
        ['quest:3', 'ended by', 'gameobject:2'],
        ['quest:3', 'rewards', 'item:4'],
        ['item:4', 'rewarded by', 'quest:3'],
        ['quest:3', 'rewards', 'spell:5'],
        ['spell:5', 'rewarded by', 'quest:3'],
        ['creature:1', 'sells', 'item:4'],
        ['item:4', 'sold by', 'creature:1'],
        ['creature:1', 'teaches', 'spell:5'],
        ['spell:5', 'taught by', 'creature:1'],
        ['item:4', 'casts', 'spell:5'],
        ['spell:5', 'cast by', 'item:4']
      ].map(async ([id, relation, target]) =>
        expect(await text('related', { id, rel: relation })).toContain(target)
      )
    )
    expect(await text('related', { id: 'creature:1', rel: 'teaches' })).not.toContain('spell:6')
    const reward = await text('related', { id: 'quest:3', rel: 'rewards' })
    expect(reward).toContain('RewardItem1')
    expect(reward).toContain('RewardChoiceItemID6')
    const casts = await text('related', { id: 'item:4', rel: 'casts' })
    expect(casts).toContain('spellid_1')
    expect(casts).toContain('spellid_5')
    expect(
      await text('sql', {
        query: 'SELECT slot, maxcount, incrtime, ExtendedCost FROM world_npc_vendor ORDER BY slot'
      })
    ).toContain('60')
  } finally {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 120_000)
