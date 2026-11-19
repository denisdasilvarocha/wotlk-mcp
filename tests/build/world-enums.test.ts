import { parseEnum } from '../../build/enums/parser.ts'
import { importWorldEnums } from '../../build/enums/world.ts'
import { initReference } from '../../build/offsets.ts'
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
    { name: 'FIRST', value: 0 },
    { name: 'SHIFT', value: 2 },
    { name: 'HEX', value: 4 },
    { name: 'COMBINED', value: 6 }
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
    rmSync(dir, { force: true, recursive: true })
  }
})

test('enum expressions preserve unsigned values and fixed underlying types', () => {
  const entries = parseEnum(
    `enum Flags : uint32 {
      HIGH = ~0x7FFFFFFFu,
      NEXT = HIGH >> 31,
      WRAP = 0xffffffffu + 2,
      MIXED = -1 | 1u,
      OCTAL = 010
    };`,
    'Flags'
  )

  expect(entries).toEqual([
    { name: 'HIGH', value: 2147483648 },
    { name: 'NEXT', value: 1 },
    { name: 'WRAP', value: 1 },
    { name: 'MIXED', value: 4294967295 },
    { name: 'OCTAL', value: 8 }
  ])
})

test('enum expressions reject unsupported widths and invalid shifts', () => {
  expect(() => parseEnum('enum Flags { FLAG = 1ULL << 2 };', 'Flags')).toThrow('Unsupported')
  expect(() => parseEnum('enum Flags { FLAG = 1u << 32 };', 'Flags')).toThrow('Unsupported')
  expect(() => parseEnum('enum Flags { FLAG = 2147483647 + 1 };', 'Flags')).toThrow('overflow')
})

test('implicit enumerators preserve their predecessor signedness', () => {
  const entries = parseEnum('enum Flags { A = 0u, B, C = ~B, D = 1 + +1 };', 'Flags')

  expect(entries).toEqual([
    { name: 'A', value: 0 },
    { name: 'B', value: 1 },
    { name: 'C', value: 4294967294 },
    { name: 'D', value: 2 }
  ])
})

test('enum expressions reject ambiguous implicit widening and undefined operations', () => {
  expect(() => parseEnum('enum Flags { A = 2147483647, B };', 'Flags')).toThrow('overflow')
  expect(() => parseEnum('enum Flags { A = (-2147483647 - 1) % -1 };', 'Flags')).toThrow('overflow')
  expect(() => parseEnum('enum Flags { A = 1++1 };', 'Flags')).toThrow('Unsupported')
  expect(() => parseEnum('enum Flags { A = 1--1 };', 'Flags')).toThrow('Unsupported')
})
