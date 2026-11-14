import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const [database, output] = args
if (args.length !== 2 || !database || !output || !existsSync(database))
  throw new Error('Usage: reference-fidelity <existing-reference.sqlite> <report.json>')
if (resolve(database) === resolve(output) || (existsSync(output) && (realpathSync(database) === realpathSync(output) || (statSync(database).dev === statSync(output).dev && statSync(database).ino === statSync(output).ino))))
  throw new Error('Report path must not be the reference database')

const db = new DatabaseSync(database, { readOnly: true })
try {
  const fields = [
    ['class', 'class', 'ClassID'],
    ['subclass', 'subclass', 'SubclassID'],
    ['display', 'displayid', 'DisplayInfoID'],
    ['inventory', 'InventoryType', 'InventoryType'],
    ['material', 'Material', 'Material'],
    ['sheath', 'sheath', 'SheatheType']
  ] as const
  const itemMismatches = Object.fromEntries(fields.map(([name]) => [name, { count: 0, examples: [] as object[] }]))
  const items = new Map<number, Record<string, unknown>>()
  for (const row of db.prepare('SELECT entry, class, subclass, displayid, InventoryType, Material, sheath FROM world_item_template').iterate())
    items.set(Number(row.entry), row)
  let commonItems = 0
  for (const client of db.prepare('SELECT ID, ClassID, SubclassID, DisplayInfoID, InventoryType, Material, SheatheType FROM dbc_Item ORDER BY ID').iterate()) {
    const world = items.get(Number(client.ID))
    if (!world) continue
    commonItems++
    for (const [name, worldField, clientField] of fields) {
      if (world[worldField] === client[clientField]) continue
      const result = itemMismatches[name]
      result.count++
      if (result.examples.length < 20)
        result.examples.push({ id: client.ID, world: world[worldField], client: client[clientField] })
    }
  }

  // Signed references encode conditions or all ranks; negative spell_group entries are group IDs instead.
  const references: [string, string[], boolean?][] = [
    ['item_template', ['requiredspell', ...Array.from({ length: 5 }, (_, i) => `spellid_${i + 1}`)]],
    ['quest_template', ['RewardSpell', 'RewardDisplaySpell']],
    ['quest_template_addon', ['SourceSpellID']],
    ['trainer_spell', ['SpellId', 'ReqAbility1', 'ReqAbility2', 'ReqAbility3']],
    ['npc_trainer', ['SpellID', 'ReqSpell']],
    ['creature_template_spell', ['Spell']],
    ['npc_spellclick_spells', ['spell_id']],
    ['playercreateinfo_cast_spell', ['spell']],
    ['playercreateinfo_spell_custom', ['Spell']],
    ['skill_discovery_template', ['spellId', 'reqSpell']],
    ['skill_extra_item_template', ['spellId', 'requiredSpecialization']],
    ['skill_perfect_item_template', ['spellId', 'requiredSpecialization']],
    ['spell_area', ['spell', 'aura_spell'], true],
    ['spell_bonus_data', ['entry']],
    ['spell_cone', ['ID']],
    ['spell_cooldown_overrides', ['Id']],
    ['spell_custom_attr', ['spell_id']],
    ['spell_jump_distance', ['ID']],
    ['spell_linked_spell', ['spell_trigger', 'spell_effect'], true],
    ['spell_loot_template', ['Entry']],
    ['spell_mixology', ['entry']],
    ['spell_pet_auras', ['spell', 'aura']],
    ['spell_proc', ['SpellId'], true],
    ['spell_ranks', ['first_spell_id', 'spell_id']],
    ['spell_required', ['spell_id', 'req_spell']],
    ['spell_target_position', ['ID']],
    ['spell_threat', ['entry']],
    ['spell_group', ['spell_id']],
    ['chrraces_dbc', ['ResSicknessSpellID']],
    ['creaturespelldata_dbc', Array.from({ length: 4 }, (_, i) => `Spells_${i + 1}`)],
    ['glyphproperties_dbc', ['SpellID']],
    ['itemset_dbc', Array.from({ length: 8 }, (_, i) => `SetSpellID_${i + 1}`)],
    ['liquidtype_dbc', ['SpellID']],
    ['overridespelldata_dbc', Array.from({ length: 10 }, (_, i) => `Spells_${i + 1}`)],
    ['skilllineability_dbc', ['Spell', 'SupercededBySpell']],
    ['spelldifficulty_dbc', Array.from({ length: 4 }, (_, i) => `DifficultySpellID_${i + 1}`)],
    ['spellshapeshiftform_dbc', Array.from({ length: 8 }, (_, i) => `PresetSpellID_${i + 1}`)],
    ['talent_dbc', [...Array.from({ length: 9 }, (_, i) => `SpellRank_${i + 1}`), 'RequiredSpellID']],
    ['spell_dbc', ['CasterAuraSpell', 'TargetAuraSpell', 'ExcludeCasterAuraSpell', 'ExcludeTargetAuraSpell', 'ModalNextSpell', ...Array.from({ length: 3 }, (_, i) => `EffectTriggerSpell_${i + 1}`)]]
  ]
  const spells = new Set<number>()
  for (const row of db.prepare('SELECT ID FROM dbc_Spell UNION SELECT ID FROM world_spell_dbc').iterate())
    spells.add(Number(row.ID))
  const missingSpells: { count: number; examples: { table: string; rowid: number; column: string; value: number; spell: number }[] } = { count: 0, examples: [] }
  for (const [table, columns, signed] of references) {
    const available = new Set(db.prepare(`PRAGMA table_info("world_${table}")`).all().map((row) => String(row.name)))
    for (const column of columns)
      if (!available.has(column)) throw new Error(`Missing reference column world_${table}.${column}`)
    const select = columns.map((column) => `"${column}"`).join(', ')
    for (const row of db.prepare(`SELECT rowid AS source_rowid, ${select} FROM "world_${table}" ORDER BY rowid`).iterate()) {
      for (const column of columns) {
        const value = Number(row[column])
        const spell = signed ? Math.abs(value) : value
        if (spell <= 0 || spells.has(spell)) continue
        missingSpells.count++
        if (missingSpells.examples.length < 20)
          missingSpells.examples.push({ table: `world_${table}`, rowid: Number(row.source_rowid), column, value, spell })
      }
    }
  }

  const missingSetItems: { count: number; examples: { itemset: number; slot: number; item: number }[] } = { count: 0, examples: [] }
  const slots = Array.from({ length: 17 }, (_, i) => `ItemID_${i + 1}`)
  for (const row of db.prepare(`SELECT ID, ${slots.join(', ')} FROM dbc_ItemSet ORDER BY ID`).iterate()) {
    for (let i = 0; i < slots.length; i++) {
      const item = Number(row[slots[i]])
      if (item <= 0 || items.has(item)) continue
      missingSetItems.count++
      if (missingSetItems.examples.length < 20) missingSetItems.examples.push({ itemset: Number(row.ID), slot: i + 1, item })
    }
  }
  writeFileSync(output, `${JSON.stringify({ commonItems, itemMismatches, missingWorldSpellReferences: missingSpells, missingItemsetItems: missingSetItems }, null, 2)}\n`)
} finally {
  db.close()
}
