import { buildLootLinks } from '../../build/links/loot.ts'
import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, expect, test } from 'vite-plus/test'

const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-loot-'))
afterAll(() => {
  rmSync(dir, { force: true, recursive: true })
})

function fixture(name: string): string {
  const file = path.join(dir, `${name}.sqlite`)

  initReference(file)

  const db = new DatabaseSync(file)

  db.exec(`CREATE TABLE world_creature_template (entry INTEGER, lootid INTEGER, skinloot INTEGER, pickpocketloot INTEGER);
    CREATE TABLE world_gameobject_template (entry INTEGER, type INTEGER, Data1 INTEGER);
    CREATE TABLE world_item_template (entry INTEGER);
    CREATE TABLE world_conditions (SourceTypeOrReferenceId INTEGER, SourceGroup INTEGER, SourceEntry INTEGER, ElseGroup INTEGER, ConditionTypeOrReference INTEGER, ConditionTarget INTEGER, ConditionValue1 INTEGER, ConditionValue2 INTEGER, ConditionValue3 INTEGER, NegativeCondition INTEGER);
    INSERT INTO world_creature_template VALUES (1,10,11,12);
    INSERT INTO world_gameobject_template VALUES (2,3,20),(3,25,20),(4,5,20);
    INSERT INTO world_item_template VALUES (100),(101),(102),(103),(104);
    INSERT INTO world_conditions VALUES (1,10,1,0,9,0,77,0,0,0);`)

  for (const table of [
    'creature',
    'gameobject',
    'item',
    'fishing',
    'skinning',
    'pickpocketing',
    'reference'
  ]) {
    db.exec(
      `CREATE TABLE world_${table}_loot_template (Entry INTEGER, Item INTEGER, Reference INTEGER, Chance REAL, QuestRequired INTEGER, LootMode INTEGER, GroupId INTEGER, MinCount INTEGER, MaxCount INTEGER, Comment TEXT)`
    )
  }

  db.exec(`INSERT INTO world_creature_loot_template VALUES (10,100,0,10,0,1,0,1,1,'direct'),(10,1,30,50,0,1,1,1,1,'ref'),(10,2,31,20,0,1,0,1,1,'second');
    INSERT INTO world_reference_loot_template VALUES (30,102,0,25,1,2,2,1,1,'inner'),(30,3,31,75,0,1,0,1,1,'nested'),(31,102,0,5,0,1,0,1,1,'leaf');
    INSERT INTO world_skinning_loot_template VALUES (11,103,0,40,0,1,0,1,1,'skin');
    INSERT INTO world_pickpocketing_loot_template VALUES (12,104,0,30,0,1,0,1,1,'pick');
    INSERT INTO world_gameobject_loot_template VALUES (20,100,0,80,0,1,0,1,1,'chest');
    INSERT INTO world_item_loot_template VALUES (101,100,0,90,0,1,0,1,1,'container');
    INSERT INTO world_fishing_loot_template VALUES (50,1,30,100,0,1,0,1,1,'valid');`)

  const add = db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')

  for (const [kind, ids] of [
    ['creature', [1]],
    ['gameobject', [2, 3, 4]],
    ['item', [100, 101, 102, 103, 104]]
  ] as const) {
    for (const id of ids) {
      add.run(`${kind}:${id}`, kind, String(id), `world_${kind}_template`, 1, '', '')
    }
  }

  db.close()

  return file
}

function text(result: { readonly content: unknown }): string {
  const { content } = result

  if (!Array.isArray(content)) {
    throw new TypeError('Expected text')
  }

  const first: unknown = content[0]

  if (
    typeof first !== 'object' ||
    first === null ||
    !('type' in first) ||
    first.type !== 'text' ||
    !('text' in first) ||
    typeof first.text !== 'string'
  ) {
    throw new Error('Expected text')
  }

  return first.text
}

test('loot paths survive artifact and packed related/sql surfaces', async () => {
  const file = fixture('valid')

  buildLootLinks(file)

  const db = new DatabaseSync(file, { readOnly: true })
  const links = db
    .prepare(
      "SELECT source_id, destination_id, notes FROM link WHERE relation='drops' ORDER BY source_id, destination_id"
    )
    .all()

  expect(
    links.some((row: Readonly<Record<string, unknown>>) => row.source_id === 'gameobject:4')
  ).toBe(false)
  expect(
    links
      .filter((row: Readonly<Record<string, unknown>>) => row.destination_id === 'item:100')
      .map((row: Readonly<Record<string, unknown>>) => row.source_id)
  ).toEqual(['creature:1', 'gameobject:2', 'gameobject:3', 'item:101'])

  const nested = String(
    links
      .filter((row: Readonly<Record<string, unknown>>) => row.source_id === 'creature:1')
      .find((row: Readonly<Record<string, unknown>>) => row.destination_id === 'item:102')?.notes
  )

  expect(nested).toContain('via ref:30')
  expect(nested).toContain('via ref:31')
  expect(nested).toContain('chance 25')
  expect(nested).toContain('group 2')
  expect(nested).toContain('quest required 1')
  expect(nested).toContain('conditions')
  expect(
    links.some((row: Readonly<Record<string, unknown>>) => row.destination_id === 'item:103')
  ).toBe(true)
  expect(
    links.some((row: Readonly<Record<string, unknown>>) => row.destination_id === 'item:104')
  ).toBe(true)
  db.close()
  unpackPackage(dir)

  const client = new Client({ name: 'loot-test', version: '1' })

  await client.connect(packagedServer(dir, file))

  try {
    expect(
      text(
        await client.callTool({ arguments: { id: 'item:102', rel: 'dropped by' }, name: 'related' })
      )
    ).toContain('creature:1')
    expect(
      text(
        await client.callTool({
          arguments: {
            query:
              'SELECT Entry, Item, Reference, Chance, GroupId FROM world_reference_loot_template ORDER BY Entry, Item'
          },
          name: 'sql'
        })
      )
    ).toContain('30\t102\t0\t25\t2')
  } finally {
    await client.close()
  }
})

test('broken and cyclic references fail atomically with source diagnostics', () => {
  for (const [name, ref, message] of [
    ['broken', 999, '999'],
    ['cycle', 30, 'cyclic']
  ] as const) {
    const file = fixture(name)
    const db = new DatabaseSync(file)

    db.exec(
      `INSERT INTO world_reference_loot_template VALUES (31,9,${ref},100,0,1,0,1,1,'invalid')`
    )
    db.close()
    expect(() => {
      buildLootLinks(file)
    }).toThrow(
      new RegExp(
        `world_reference_loot_template.*${message}|${message}.*world_reference_loot_template`,
        'iu'
      )
    )

    const check = new DatabaseSync(file, { readOnly: true })

    expect(check.prepare("SELECT count(*) AS n FROM link WHERE relation='drops'").get()?.n).toBe(0)
    check.close()
  }
})

test.each([
  ['missing reference', -999, 'entry 41 item 9:.*missing reference ref:999 \\(stored -999\\)'],
  ['cyclic reference', 40, 'entry 41 item 9:.*cyclic reference ref:40 -> ref:41 -> ref:40']
] as const)('rejects an unused template with a %s', (name, ref, message) => {
  const file = fixture(name)
  const db = new DatabaseSync(file)

  db.exec(`INSERT INTO world_reference_loot_template VALUES
    (40,8,41,100,0,1,0,1,1,'unused'),
    (41,9,${ref},100,0,1,0,1,1,'invalid');`)
  db.close()

  expect(() => {
    buildLootLinks(file)
  }).toThrow(new RegExp(`world_reference_loot_template ${message}`, 'u'))
})

test('rejects a missing reference from a loot template without a Record owner', () => {
  const file = fixture('unowned')
  const db = new DatabaseSync(file)

  db.exec(`INSERT INTO world_creature_template VALUES (99,90,0,0);
    INSERT INTO world_creature_loot_template VALUES (90,9,999,100,0,1,0,1,1,'invalid');`)
  db.close()

  expect(() => {
    buildLootLinks(file)
  }).toThrow(/world_creature_loot_template entry 90 item 9:.*missing reference ref:999/u)
})

test('rejects a missing reference from a SQL-only loot table', () => {
  const file = fixture('fishing')
  const db = new DatabaseSync(file)

  db.exec("INSERT INTO world_fishing_loot_template VALUES (50,9,-999,100,0,1,0,1,1,'invalid')")
  db.close()

  expect(() => {
    buildLootLinks(file)
  }).toThrow(
    /world_fishing_loot_template entry 50 item 9:.*missing reference ref:999 \(stored -999\)/u
  )
})
