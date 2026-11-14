import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, expect, test } from 'vite-plus/test'

import { unpackPackage } from './package.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-loot-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixture(name: string): string {
  const file = path.join(dir, `${name}.sqlite`)
  execFileSync('vpx', ['scripts/init-reference.ts', file])
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE world_creature_template (entry INTEGER, lootid INTEGER, skinloot INTEGER, pickpocketloot INTEGER);
    CREATE TABLE world_gameobject_template (entry INTEGER, type INTEGER, Data1 INTEGER);
    CREATE TABLE world_item_template (entry INTEGER);
    CREATE TABLE world_conditions (SourceTypeOrReferenceId INTEGER, SourceGroup INTEGER, SourceEntry INTEGER, ElseGroup INTEGER, ConditionTypeOrReference INTEGER, ConditionTarget INTEGER, ConditionValue1 INTEGER, ConditionValue2 INTEGER, ConditionValue3 INTEGER, NegativeCondition INTEGER);
    INSERT INTO world_creature_template VALUES (1,10,11,12);
    INSERT INTO world_gameobject_template VALUES (2,3,20),(3,25,20),(4,5,20);
    INSERT INTO world_item_template VALUES (100),(101),(102),(103),(104);
    INSERT INTO world_conditions VALUES (1,10,1,0,9,0,77,0,0,0);`)
  for (const table of ['creature', 'gameobject', 'item', 'skinning', 'pickpocketing', 'reference'])
    db.exec(
      `CREATE TABLE world_${table}_loot_template (Entry INTEGER, Item INTEGER, Reference INTEGER, Chance REAL, QuestRequired INTEGER, LootMode INTEGER, GroupId INTEGER, MinCount INTEGER, MaxCount INTEGER, Comment TEXT)`
    )
  db.exec(`INSERT INTO world_creature_loot_template VALUES (10,100,0,10,0,1,0,1,1,'direct'),(10,1,30,50,0,1,1,1,1,'ref'),(10,2,31,20,0,1,0,1,1,'second');
    INSERT INTO world_reference_loot_template VALUES (30,102,0,25,1,2,2,1,1,'inner'),(30,3,31,75,0,1,0,1,1,'nested'),(31,102,0,5,0,1,0,1,1,'leaf');
    INSERT INTO world_skinning_loot_template VALUES (11,103,0,40,0,1,0,1,1,'skin');
    INSERT INTO world_pickpocketing_loot_template VALUES (12,104,0,30,0,1,0,1,1,'pick');
    INSERT INTO world_gameobject_loot_template VALUES (20,100,0,80,0,1,0,1,1,'chest');
    INSERT INTO world_item_loot_template VALUES (101,100,0,90,0,1,0,1,1,'container');`)
  const add = db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const [kind, ids] of [
    ['creature', [1]],
    ['gameobject', [2, 3, 4]],
    ['item', [100, 101, 102, 103, 104]]
  ] as const)
    for (const id of ids)
      add.run(`${kind}:${id}`, kind, String(id), `world_${kind}_template`, 1, '', '')
  db.close()
  return file
}
function run(file: string): ReturnType<typeof spawnSync> {
  return spawnSync('vpx', ['scripts/build-loot.ts', file], { encoding: 'utf8' })
}
function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const { content } = result
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected text')
  return String(content[0].text)
}

test('loot paths survive artifact and packed related/sql surfaces', async () => {
  const file = fixture('valid')
  const result = run(file)
  expect(result.status).toBe(0)
  const db = new DatabaseSync(file, { readOnly: true })
  const links = db
    .prepare(
      "SELECT source_id, destination_id, notes FROM link WHERE relation='drops' ORDER BY source_id, destination_id"
    )
    .all()
  expect(links.some((row) => row.source_id === 'gameobject:4')).toBe(false)
  expect(
    links.filter((row) => row.destination_id === 'item:100').map((row) => row.source_id)
  ).toEqual(['creature:1', 'gameobject:2', 'gameobject:3', 'item:101'])
  const nested = String(
    links.find((row) => row.source_id === 'creature:1' && row.destination_id === 'item:102')?.notes
  )
  expect(nested).toContain('via ref:30')
  expect(nested).toContain('via ref:31')
  expect(nested).toContain('chance 25')
  expect(nested).toContain('group 2')
  expect(nested).toContain('quest required 1')
  expect(nested).toContain('conditions')
  expect(links.some((row) => row.destination_id === 'item:103')).toBe(true)
  expect(links.some((row) => row.destination_id === 'item:104')).toBe(true)
  db.close()
  unpackPackage(dir)
  const client = new Client({ name: 'loot-test', version: '1' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(dir, 'package/dist/index.mjs')],
      env: { ...process.env, WOTLK_MCP_DB: file }
    })
  )
  try {
    expect(
      text(
        await client.callTool({ name: 'related', arguments: { id: 'item:102', rel: 'dropped by' } })
      )
    ).toContain('creature:1')
    expect(
      text(
        await client.callTool({
          name: 'sql',
          arguments: {
            query:
              'SELECT Entry, Item, Reference, Chance, GroupId FROM world_reference_loot_template ORDER BY Entry, Item'
          }
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
    const result = run(file)
    expect(result.status).not.toBe(0)
    expect(String(result.stderr).toLowerCase()).toContain(message)
    expect(result.stderr).toContain('world_reference_loot_template')
    const check = new DatabaseSync(file, { readOnly: true })
    expect(check.prepare("SELECT count(*) AS n FROM link WHERE relation='drops'").get()?.n).toBe(0)
    check.close()
  }
})
