import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test } from 'vite-plus/test'

import { initReference } from '../build/offsets.ts'
import { importWorldEnums } from '../build/world-enums.ts'

const ROOT = 'azerothcore-wotlk-2948c203faa0d23c4772441119ebe98e5b7cad95'

const ITEM_ENUM_NAMES = [
  'InventoryType',
  'ItemBondingType',
  'ItemFlags',
  'ItemFlags2',
  'ItemModType',
  'ItemSpelltriggerType',
  ...[
    'Consumable',
    'Container',
    'Weapon',
    'Gem',
    'Armor',
    'Reagent',
    'Projectile',
    'TradeGoods',
    'Generic',
    'Recipe',
    'Money',
    'Quiver',
    'Quest',
    'Key',
    'Permanent',
    'Junk',
    'Glyph'
  ].map((name) => `ItemSubclass${name}`)
]

const SHARED_ENUM_NAMES = [
  'Races',
  'Classes',
  'SpellSchools',
  'ItemQualities',
  'GameobjectTypes',
  'CreatureTypeFlags',
  'CreatureEliteType',
  'QuestTypes',
  'UnitDynFlags'
]

const HEADERS: [string, string[]][] = [
  ['src/server/shared/SharedDefines.h', SHARED_ENUM_NAMES],
  ['src/server/game/Entities/Item/ItemTemplate.h', ITEM_ENUM_NAMES],
  ['src/server/game/Entities/Unit/UnitDefines.h', ['NPCFlags', 'UnitFlags', 'UnitFlags2']],
  ['src/server/game/Quests/QuestDef.h', ['QuestFlags']],
  ['src/server/game/Spells/Auras/SpellAuraDefines.h', ['AuraType']]
]

const ITEM_CLASS_ENUM =
  '\nenum ItemClass { ITEM_CLASS_CONSUMABLE, ITEM_CLASS_CONTAINER, ITEM_CLASS_WEAPON, ITEM_CLASS_GEM, ITEM_CLASS_ARMOR, ITEM_CLASS_REAGENT, ITEM_CLASS_PROJECTILE, ITEM_CLASS_TRADE_GOODS, ITEM_CLASS_GENERIC, ITEM_CLASS_RECIPE, ITEM_CLASS_MONEY, ITEM_CLASS_QUIVER, ITEM_CLASS_QUEST, ITEM_CLASS_KEY, ITEM_CLASS_PERMANENT, ITEM_CLASS_MISC, ITEM_CLASS_GLYPH };'

function writeHeaders(
  dir: string,
  headers: readonly (readonly [string, readonly string[]])[]
): void {
  for (const [filename, names] of headers) {
    const full = path.join(dir, ROOT, filename)

    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(
      full,
      names
        .map(
          (name) =>
            `enum ${name} { ${name}_FIRST = 0, ${name}_SHIFT = (1 << 1), ${name}_HEX = 0x4, ${name}_COMBINED = ${name}_SHIFT | ${name}_HEX };`
        )
        .join('\n')
    )
  }
}

function worldTableColumns(table: string): readonly string[] {
  return readFileSync('data/world/schema-columns.tsv', 'utf8')
    .split('\n')
    .map((line): readonly string[] => line.split('\t'))
    .filter(([name]) => name === table)
    .map((row) => `"${row[2]}" INTEGER`)
}

function createWorldSchema(database: string): void {
  const db = new DatabaseSync(database)

  for (const table of [
    'item_template',
    'creature_template',
    'quest_template',
    'gameobject_template'
  ]) {
    const columns = worldTableColumns(table).join(',')

    db.exec(`CREATE TABLE world_${table} (${columns})`)
  }

  db.exec(
    `CREATE TABLE dbc_ItemClass (ClassID INTEGER, ClassName_lang TEXT); CREATE TABLE dbc_CreatureType (ID INTEGER, Name_lang TEXT); CREATE TABLE dbc_CreatureFamily (ID INTEGER, Name_lang TEXT); CREATE TABLE dbc_FactionTemplate (ID INTEGER, Faction INTEGER); CREATE TABLE dbc_Faction (ID INTEGER, Name_lang TEXT);`
  )
  db.close()
}

function assertImportedEnums(database: string): void {
  const output = new DatabaseSync(database)

  expect(
    output
      .prepare(
        "SELECT value, name FROM enum_value WHERE enum_name = 'ItemQualities' ORDER BY value"
      )
      .all()
  ).toEqual([
    { value: 0, name: 'FIRST' },
    { value: 2, name: 'SHIFT' },
    { value: 4, name: 'HEX' },
    { value: 6, name: 'COMBINED' }
  ])
  output.close()
}

function assertEmptyEnumTables(database: string): void {
  const failed = new DatabaseSync(database, { readOnly: true })

  expect(failed.prepare('SELECT count(*) AS n FROM enum_value').get()?.n).toBe(0)
  expect(failed.prepare('SELECT count(*) AS n FROM enum_field').get()?.n).toBe(0)
  failed.close()
}

test('world enum import parses expressions and rejects missing mapped columns', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'world-enums-'))

  try {
    writeHeaders(dir, HEADERS)
    appendFileSync(
      path.join(dir, ROOT, 'src/server/game/Entities/Item/ItemTemplate.h'),
      ITEM_CLASS_ENUM
    )

    const database = path.join(dir, 'reference.sqlite')

    initReference(database)
    createWorldSchema(database)
    importWorldEnums(database, path.join(dir, ROOT))
    assertImportedEnums(database)

    const other = path.join(dir, 'missing.sqlite')

    initReference(other)
    expect(() => {
      importWorldEnums(other, path.join(dir, ROOT))
    }).toThrow('Missing mapped column world_item_template.Quality')
    assertEmptyEnumTables(other)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
