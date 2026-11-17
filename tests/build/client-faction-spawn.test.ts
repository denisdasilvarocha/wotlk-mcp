import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

import { buildClientFactionSpawnLinks } from '../../build/links/client-faction-spawn.ts'
import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-client-links-'))
const file = path.join(dir, 'reference.sqlite')
const client = new Client({ name: 'client-links-test', version: '1' })

function columns(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}_${i + 1} INTEGER`).join(', ')
}

beforeAll(async () => {
  initReference(file)

  const db = new DatabaseSync(file)

  db.exec(`CREATE TABLE dbc_ItemSet (ID INTEGER, ${columns('ItemID', 17)});
    CREATE TABLE dbc_Talent (ID INTEGER, ${columns('SpellRank', 9)});
    CREATE TABLE dbc_SkillLineAbility (ID INTEGER, SkillLine INTEGER, Spell INTEGER);
    CREATE TABLE dbc_FactionTemplate (ID INTEGER, Faction INTEGER);
    CREATE TABLE world_creature_template (entry INTEGER, faction INTEGER);
    CREATE TABLE world_creature (guid INTEGER, id INTEGER, map INTEGER, position_x REAL);
    CREATE TABLE world_creature_multispawn (spawnId INTEGER, entry INTEGER);
    CREATE TABLE world_gameobject (guid INTEGER, id INTEGER, map INTEGER, position_x REAL);
    INSERT INTO dbc_ItemSet (ID, ItemID_1, ItemID_17, ItemID_2) VALUES (1, 10, 11, 999);
    INSERT INTO dbc_Talent (ID, SpellRank_1, SpellRank_9) VALUES (2, 20, 21);
    INSERT INTO dbc_SkillLineAbility VALUES (7, 30, 20);
    INSERT INTO dbc_FactionTemplate VALUES (40, 41);
    INSERT INTO world_creature_template VALUES (50, 40), (51, 40);
    INSERT INTO world_creature VALUES (1, 50, 60, 42), (2, 50, 60, 43), (3, 51, 60, 44);
    INSERT INTO world_creature_multispawn VALUES (1, 51), (2, 51), (3, 51);
    INSERT INTO world_gameobject VALUES (4, 70, 60, 45), (5, 70, 60, 46);
  `)

  const insert = db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')

  for (const id of [
    'itemset:1',
    'item:10',
    'item:11',
    'talent:2',
    'spell:20',
    'spell:21',
    'skillline:30',
    'faction:41',
    'creature:50',
    'creature:51',
    'gameobject:70',
    'map:60'
  ]) {
    insert.run(id, id.split(':')[0], id, 'dbc_ItemSet', 1, '', '')
  }

  db.close()
  buildClientFactionSpawnLinks(file)
  unpackPackage(dir)
  await client.connect(packagedServer(dir, file))
})

afterAll(async () => {
  await client.close()
  rmSync(dir, { force: true, recursive: true })
})

test('navigates each independent key in both directions, preserving spawn rows', async () => {
  await Promise.all(
    [
      ['itemset:1', 'contains', 'item:10'],
      ['itemset:1', 'contains', 'item:11'],
      ['item:11', 'contained in', 'itemset:1'],
      ['talent:2', 'grants', 'spell:20'],
      ['talent:2', 'grants', 'spell:21'],
      ['spell:21', 'granted by', 'talent:2'],
      ['spell:20', 'belongs to', 'skillline:30'],
      ['skillline:30', 'includes', 'spell:20'],
      ['creature:50', 'faction', 'faction:41'],
      ['faction:41', 'faction of', 'creature:50'],
      ['creature:50', 'spawns in', 'map:60 (2 stored spawn rows)'],
      ['creature:51', 'spawns in', 'map:60 (3 stored spawn rows)'],
      ['gameobject:70', 'spawns in', 'map:60 (2 stored spawn rows)'],
      ['map:60', 'spawns', 'gameobject:70 (2 stored spawn rows)']
    ].map(async ([id, rel, expected]: readonly string[]) => {
      const result = await client.callTool({ arguments: { id, rel }, name: 'related' })

      expect(JSON.stringify(result.content)).toContain(expected)
    })
  )

  const result = await client.callTool({
    arguments: { id: 'itemset:1', rel: 'contains' },
    name: 'related'
  })

  expect(JSON.stringify(result.content)).not.toContain('item:999')

  const db = new DatabaseSync(file, { readOnly: true })

  expect(db.prepare('SELECT position_x FROM world_creature WHERE guid = 1').get()?.position_x).toBe(
    42
  )
  expect(db.prepare('SELECT COUNT(*) AS n FROM world_creature_multispawn').get()?.n).toBe(3)
  db.close()
})
