import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { z } from 'zod'

import { parseEnum } from './enum-parser.ts'

export function importWorldEnums(database: string, sourceDirectory: string): void {
  const mappings: z.infer<typeof schema>[] = []
  const paths = [
    'src/server/shared/SharedDefines.h',
    'src/server/game/Entities/Item/ItemTemplate.h',
    'src/server/game/Entities/Unit/UnitDefines.h',
    'src/server/game/Quests/QuestDef.h'
  ]
  const headers = paths.map((name) => readFileSync(path.join(sourceDirectory, name), 'utf8'))
  const schema = z
    .object({
      table: z.string().regex(/^world_\w+$/),
      field: z.string().regex(/^\w+$/),
      name: z.string().min(1),
      flags: z.boolean(),
      conditionField: z.string().optional(),
      conditionValue: z.number().int().optional()
    })
    .refine((x) => (x.conditionField === undefined) === (x.conditionValue === undefined))

  function add(
    table: string,
    field: string,
    name: string,
    flags = false,
    conditionField?: string,
    conditionValue?: number
  ): void {
    mappings.push(
      schema.parse({ table: `world_${table}`, field, name, flags, conditionField, conditionValue })
    )
  }

  add('item_template', 'Quality', 'ItemQualities')
  add('item_template', 'InventoryType', 'InventoryType')
  add('item_template', 'bonding', 'ItemBondingType')
  add('item_template', 'Flags', 'ItemFlags', true)
  add('item_template', 'FlagsExtra', 'ItemFlags2', true)
  add('item_template', 'AllowableClass', 'ClassMask', true)
  add('item_template', 'AllowableRace', 'RaceMask', true)

  for (let i = 1; i <= 10; i++) add('item_template', `stat_type${i}`, 'ItemModType')

  for (let i = 1; i <= 2; i++) add('item_template', `dmg_type${i}`, 'SpellSchools')

  for (let i = 1; i <= 5; i++) add('item_template', `spelltrigger_${i}`, 'ItemSpelltriggerType')

  const itemClasses = parseEnum(headers[1], 'ItemClass')
  const subclasses = [
    ['Consumable', 'CONSUMABLE'],
    ['Container', 'CONTAINER'],
    ['Weapon', 'WEAPON'],
    ['Gem', 'GEM'],
    ['Armor', 'ARMOR'],
    ['Reagent', 'REAGENT'],
    ['Projectile', 'PROJECTILE'],
    ['TradeGoods', 'TRADE_GOODS'],
    ['Generic', 'GENERIC'],
    ['Recipe', 'RECIPE'],
    ['Money', 'MONEY'],
    ['Quiver', 'QUIVER'],
    ['Quest', 'QUEST'],
    ['Key', 'KEY'],
    ['Permanent', 'PERMANENT'],
    ['Junk', 'MISC'],
    ['Glyph', 'GLYPH']
  ]

  for (const [name, symbol] of subclasses) {
    const itemClass = itemClasses.find((entry) => entry.name === `ITEM_CLASS_${symbol}`)

    if (!itemClass) throw new Error(`Missing pinned item class ITEM_CLASS_${symbol}`)

    add('item_template', 'subclass', `ItemSubclass${name}`, false, 'class', itemClass.value)
  }

  add('creature_template', 'rank', 'CreatureEliteType')
  add('creature_template', 'unit_class', 'Classes')
  add('creature_template', 'npcflag', 'NPCFlags', true)
  add('creature_template', 'unit_flags', 'UnitFlags', true)
  add('creature_template', 'unit_flags2', 'UnitFlags2', true)
  add('creature_template', 'dynamicflags', 'UnitDynFlags', true)
  add('creature_template', 'type_flags', 'CreatureTypeFlags', true)
  add('quest_template', 'QuestInfoID', 'QuestTypes')
  add('quest_template', 'Flags', 'QuestFlags', true)
  add('quest_template', 'AllowableRaces', 'RaceMask', true)
  add('gameobject_template', 'type', 'GameobjectTypes')
  add('item_template', 'class', 'reference.ItemClass')
  add('creature_template', 'type', 'reference.CreatureType')
  add('creature_template', 'family', 'reference.CreatureFamily')
  add('creature_template', 'faction', 'reference.FactionTemplate')

  const db = new DatabaseSync(database)

  try {
    db.exec('BEGIN IMMEDIATE')

    for (const mapping of mappings) {
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info("${mapping.table}")`)
          .all()
          .map((row) => row.name)
      )

      for (const column of [mapping.field, mapping.conditionField])
        if (column !== undefined && !columns.has(column))
          throw new Error(`Missing mapped column ${mapping.table}.${column}`)
    }

    const names = new Set(mappings.map((mapping) => mapping.name))

    const insertValue = db.prepare(
      'INSERT INTO enum_value (enum_name, value, name) VALUES (?, ?, ?)'
    )

    for (const name of names) {
      if (name.startsWith('reference.')) continue

      let source = name

      if (name === 'ClassMask') source = 'Classes'

      if (name === 'RaceMask') source = 'Races'

      const header = headers.find((text) =>
        new RegExp(`\\benum\\s+${source}\\b[^;{}]*\\{`).test(
          text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
        )
      )

      if (!header) throw new Error(`Missing pinned enum ${source}`)

      let entries = parseEnum(header, source)

      if (name === 'ClassMask' || name === 'RaceMask') {
        entries = entries.filter((entry) => entry.value > 0)

        for (const entry of entries) entry.value = 2 ** (entry.value - 1)
      }

      let prefix = entries[0].name

      for (const entry of entries)
        while (!entry.name.startsWith(prefix)) prefix = prefix.slice(0, -1)

      prefix = prefix.slice(0, prefix.lastIndexOf('_') + 1)

      for (const entry of entries)
        insertValue.run(name, entry.value, entry.name.slice(prefix.length) || entry.name)
    }

    const refs = [
      ['reference.ItemClass', 'SELECT ClassID AS id, ClassName_lang AS name FROM dbc_ItemClass'],
      ['reference.CreatureType', 'SELECT ID AS id, Name_lang AS name FROM dbc_CreatureType'],
      ['reference.CreatureFamily', 'SELECT ID AS id, Name_lang AS name FROM dbc_CreatureFamily'],
      [
        'reference.FactionTemplate',
        'SELECT t.ID AS id, f.Name_lang AS name FROM dbc_FactionTemplate t JOIN dbc_Faction f ON f.ID = t.Faction'
      ]
    ]

    for (const [name, query] of refs) {
      let rows

      try {
        rows = db.prepare(query).all()
      } catch {
        throw new Error(
          `Missing Client Data for ${name}; import Client Data and World Data before world enum mappings`
        )
      }

      for (const row of rows)
        if (typeof row.name === 'string' && row.name)
          insertValue.run(name, Number(row.id), row.name)
    }

    const insertField = db.prepare(
      'INSERT INTO enum_field (source_table, field, enum_name, flags, condition_field, condition_value) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const sqlNull: null = JSON.parse('null')

    for (const field of mappings)
      insertField.run(
        field.table,
        field.field,
        field.name,
        Number(field.flags),
        field.conditionField ?? sqlNull,
        field.conditionValue ?? sqlNull
      )

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
