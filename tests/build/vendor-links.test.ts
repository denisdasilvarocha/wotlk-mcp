import { buildWorldLinks } from '../../build/links/world.ts'
import { initReference } from '../../build/offsets.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

test('vendor references retain the selling creature and each stored stock row', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vendor-links-'))
  const database = path.join(dir, 'reference.sqlite')

  try {
    initReference(database)

    const db = new DatabaseSync(database)

    try {
      db.exec(`
        CREATE TABLE world_creature_queststarter (id INTEGER, quest INTEGER);
        CREATE TABLE world_creature_questender (id INTEGER, quest INTEGER);
        CREATE TABLE world_gameobject_queststarter (id INTEGER, quest INTEGER);
        CREATE TABLE world_gameobject_questender (id INTEGER, quest INTEGER);
        CREATE TABLE world_creature_default_trainer (CreatureId INTEGER, TrainerId INTEGER);
        CREATE TABLE world_trainer_spell (TrainerId INTEGER, SpellId INTEGER, MoneyCost INTEGER, ReqSkillLine INTEGER, ReqSkillRank INTEGER, ReqLevel INTEGER);
        CREATE TABLE world_quest_template (ID INTEGER, RewardItem1 INTEGER, RewardAmount1 INTEGER, RewardItem2 INTEGER, RewardAmount2 INTEGER, RewardItem3 INTEGER, RewardAmount3 INTEGER, RewardItem4 INTEGER, RewardAmount4 INTEGER, RewardChoiceItemID1 INTEGER, RewardChoiceItemQuantity1 INTEGER, RewardChoiceItemID2 INTEGER, RewardChoiceItemQuantity2 INTEGER, RewardChoiceItemID3 INTEGER, RewardChoiceItemQuantity3 INTEGER, RewardChoiceItemID4 INTEGER, RewardChoiceItemQuantity4 INTEGER, RewardChoiceItemID5 INTEGER, RewardChoiceItemQuantity5 INTEGER, RewardChoiceItemID6 INTEGER, RewardChoiceItemQuantity6 INTEGER, RewardSpell INTEGER, RewardDisplaySpell INTEGER);
        CREATE TABLE world_item_template (entry INTEGER, spellid_1 INTEGER, spelltrigger_1 INTEGER, spellid_2 INTEGER, spelltrigger_2 INTEGER, spellid_3 INTEGER, spelltrigger_3 INTEGER, spellid_4 INTEGER, spelltrigger_4 INTEGER, spellid_5 INTEGER, spelltrigger_5 INTEGER);
        CREATE TABLE world_npc_vendor (entry INTEGER, slot INTEGER, item INTEGER, maxcount INTEGER, incrtime INTEGER, ExtendedCost INTEGER);
        INSERT INTO record VALUES
          ('creature:34080', 'creature', 'Captain O’Neal', 'world_creature_template', 1, '', ''),
          ('creature:34081', 'creature', 'Second vendor', 'world_creature_template', 2, '', ''),
          ('item:28118', 'item', 'Runed Ornate Ruby', 'world_item_template', 1, '', ''),
          ('item:900', 'item', 'Not the reference', 'world_item_template', 2, '', '');
        INSERT INTO world_npc_vendor VALUES
          (34080, 0, 28118, 0, 0, 0), (34080, 1, -900, 0, 0, 0),
          (34081, 3, -900, 0, 0, 0), (34081, 4, -999, 0, 0, 0),
          (900, 2, -901, 0, 0, 0), (900, 5, 28118, 2, 60, 7),
          (901, 4, -900, 0, 0, 0), (901, 5, 28118, 2, 60, 7), (901, 6, 999, 0, 0, 0);
      `)
    } finally {
      db.close()
    }

    buildWorldLinks(database)

    const result = new DatabaseSync(database, { readOnly: true })

    try {
      const links = result
        .prepare(
          "SELECT source_id, destination_id, notes FROM link WHERE relation = 'sells' ORDER BY source_id, destination_id"
        )
        .all()

      expect(links).toEqual([
        {
          source_id: 'creature:34080',
          destination_id: 'item:28118',
          notes: JSON.stringify([
            'entry=900, slot=5, maxcount=2, incrtime=60, ExtendedCost=7',
            'entry=901, slot=5, maxcount=2, incrtime=60, ExtendedCost=7',
            'slot=0, maxcount=0, incrtime=0, ExtendedCost=0'
          ])
        },
        {
          source_id: 'creature:34081',
          destination_id: 'item:28118',
          notes: JSON.stringify([
            'entry=900, slot=5, maxcount=2, incrtime=60, ExtendedCost=7',
            'entry=901, slot=5, maxcount=2, incrtime=60, ExtendedCost=7'
          ])
        }
      ])
    } finally {
      result.close()
    }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
