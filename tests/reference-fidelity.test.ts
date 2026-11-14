import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test } from 'vite-plus/test'

const command = 'scripts/reference-fidelity.ts'
const tables = `item_template quest_template quest_template_addon trainer_spell npc_trainer creature_template_spell npc_spellclick_spells playercreateinfo_cast_spell playercreateinfo_spell_custom skill_discovery_template skill_extra_item_template skill_perfect_item_template spell_area spell_bonus_data spell_cone spell_cooldown_overrides spell_custom_attr spell_jump_distance spell_linked_spell spell_loot_template spell_mixology spell_pet_auras spell_proc spell_ranks spell_required spell_target_position spell_threat spell_group chrraces_dbc creaturespelldata_dbc glyphproperties_dbc itemset_dbc liquidtype_dbc overridespelldata_dbc skilllineability_dbc spelldifficulty_dbc spellshapeshiftform_dbc talent_dbc spell_dbc`.split(' ')

test('reports cross-source discrepancies with bounded evidence without changing the reference', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fidelity-'))
  const file = path.join(dir, 'reference.sqlite')
  const report = path.join(dir, 'report.json')
  try {
    const db = new DatabaseSync(file)
    const columns = new Map<string, string[]>()
    for (const line of readFileSync('world/schema-columns.tsv', 'utf8').split('\n')) {
      const [table, , column] = line.split('\t')
      if (!tables.includes(table)) continue
      if (!columns.has(table)) columns.set(table, [])
      columns.get(table)!.push(`"${column}" INTEGER`)
    }
    for (const table of tables) db.exec(`CREATE TABLE "world_${table}" (${columns.get(table)!.join(',')})`)
    db.exec(`
      CREATE TABLE dbc_Item (ID INTEGER, ClassID INTEGER, SubclassID INTEGER, DisplayInfoID INTEGER, InventoryType INTEGER, Material INTEGER, SheatheType INTEGER);
      CREATE TABLE dbc_Spell (ID INTEGER);
      CREATE TABLE dbc_ItemSet (ID INTEGER, ${Array.from({ length: 17 }, (_, i) => `ItemID_${i + 1} INTEGER`).join(', ')});
      INSERT INTO world_item_template (entry, class, subclass, displayid, InventoryType, Material, sheath, spellid_1, spellid_5, requiredspell) VALUES (1, 1, 2, 3, 4, 5, 6, 100, 101, 102);
      INSERT INTO dbc_Item VALUES (1, 11, 12, 13, 14, 15, 16), (999, 1, 1, 1, 1, 1, 1);
      INSERT INTO dbc_Spell VALUES (100);
      INSERT INTO world_spell_dbc (ID) VALUES (101);
      INSERT INTO world_quest_template (ID, RewardSpell, RewardDisplaySpell) VALUES (7, 103, 104);
      INSERT INTO world_trainer_spell (TrainerId, SpellId, ReqAbility3) VALUES (8, 105, 106);
      INSERT INTO world_spell_linked_spell (spell_trigger, spell_effect) VALUES (-107, 100);
      INSERT INTO world_spell_group (id, spell_id) VALUES (1, -108);
      INSERT INTO dbc_ItemSet (ID, ItemID_1, ItemID_17) VALUES (4, 1, 200);
    `)
    for (let id = 2; id <= 25; id++) {
      db.prepare('INSERT INTO world_item_template (entry, class, subclass, displayid, InventoryType, Material, sheath) VALUES (?, 1, 2, 3, 4, 5, 6)').run(id)
      db.prepare('INSERT INTO dbc_Item VALUES (?, 11, 2, 3, 4, 5, 6)').run(id)
    }
    db.close()
    const before = createHash('sha256').update(readFileSync(file)).digest('hex')
    execFileSync(process.execPath, [command, file, report])
    const result = JSON.parse(readFileSync(report, 'utf8'))
    expect(result.commonItems).toBe(25)
    expect(result.itemMismatches.class.count).toBe(25)
    expect(result.itemMismatches.class.examples).toHaveLength(20)
    expect(result.itemMismatches.class.examples[0]).toEqual({ id: 1, world: 1, client: 11 })
    for (const field of ['subclass', 'display', 'inventory', 'material', 'sheath'])
      expect(result.itemMismatches[field].count).toBe(1)
    expect(result.missingWorldSpellReferences.count).toBe(6)
    expect(result.missingWorldSpellReferences.examples.map((example: { spell: number }) => example.spell)).toEqual([102, 103, 104, 105, 106, 107])
    expect(result.missingItemsetItems).toEqual({ count: 1, examples: [{ itemset: 4, slot: 17, item: 200 }] })
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before)
    expect(spawnSync(process.execPath, [command, file, file]).status).not.toBe(0)
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
