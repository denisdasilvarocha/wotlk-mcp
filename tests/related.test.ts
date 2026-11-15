import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

import { addLink } from '../build/links.ts'
import { initReference } from '../build/offsets.ts'
import { packagedServer, unpackPackage } from './package.ts'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-related-'))
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'related-test', version: '1' })
const pairs = [
  ['drops', 'dropped by'],
  ['starts', 'started by'],
  ['ends', 'ended by'],
  ['rewards', 'rewarded by'],
  ['sells', 'sold by'],
  ['teaches', 'taught by'],
  ['casts', 'cast by'],
  ['contains', 'contained in'],
  ['grants', 'granted by'],
  ['belongs to', 'includes'],
  ['faction', 'faction of'],
  ['spawns in', 'spawns'],
  ['implemented by', 'implements']
]

beforeAll(async () => {
  initReference(database)
  unpackPackage(directory)

  const db = new DatabaseSync(database)

  db.exec(`CREATE TABLE world_evidence (creature INTEGER, item INTEGER, chance TEXT);
    INSERT INTO world_evidence VALUES (1, 2, '25%'), (1, 2, '5%'), (1, 2, '25%');
    INSERT INTO record VALUES ('creature:1', 'creature', 'Creature', 'world_evidence', 1, '', ''),
      ('item:2', 'item', 'Item', 'world_evidence', 1, '', ''),
      ('item:10', 'item', 'Other', 'world_evidence', 1, '', ''),
      ('quest:1', 'quest', 'Quest', 'world_evidence', 1, '', '');`)

  for (const row of db.prepare('SELECT chance FROM world_evidence').all())
    addLink(db, 'creature:1', 'drops', 'item:2', String(row.chance))

  addLink(db, 'creature:1', 'drops', 'item:10')
  addLink(db, 'creature:1', 'starts', 'quest:1')
  addLink(db, 'quest:1', 'rewards', 'item:2', 'choice')

  const insert = db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')

  for (const [index, [relation]] of pairs.entries()) {
    const destination = `item:destination${index}`
    const source = `item:source${index}`

    insert.run(source, 'item', source, 'world_evidence', 1, '', '')
    insert.run(destination, 'item', destination, 'world_evidence', 1, '', '')
    addLink(db, source, relation, destination)
  }

  db.close()
  await client.connect(packagedServer(directory, database))
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { recursive: true, force: true })
})

async function related(args: Record<string, unknown>): ReturnType<typeof client.callTool> {
  return client.callTool({ name: 'related', arguments: args })
}

test('related is discoverable with all forward and inverse names', async () => {
  const tool = (await client.listTools()).tools.find((entry) => entry.name === 'related')

  expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
  expect(tool?.inputSchema.properties?.rel).toMatchObject({
    enum: pairs.flat()
  })
})

test('navigates and filters both directions with distinct sorted notes', async () => {
  expect((await related({ id: 'creature:1' })).content).toEqual([
    { type: 'text', text: 'drops item:10\ndrops item:2 (25%; 5%)\nstarts quest:1\n1–3 of 3; end' }
  ])
  expect((await related({ id: 'item:2' })).content).toEqual([
    {
      type: 'text',
      text: 'dropped by creature:1 (25%; 5%)\nrewarded by quest:1 (choice)\n1–2 of 2; end'
    }
  ])
  expect((await related({ id: 'item:2', rel: 'dropped by' })).content).toEqual([
    { type: 'text', text: 'dropped by creature:1 (25%; 5%)\n1–1 of 1; end' }
  ])
  expect((await related({ id: 'item:2', rel: 'drops' })).content).toEqual([
    { type: 'text', text: '0–0 of 0; end' }
  ])
  expect((await related({ id: 'offset:missing' })).content).toEqual([
    { type: 'text', text: '0–0 of 0; end' }
  ])
})

test('paginates the sorted neighborhood including offsets past its end', async () => {
  expect((await related({ id: 'creature:1', limit: 1, offset: 1 })).content).toEqual([
    { type: 'text', text: 'drops item:2 (25%; 5%)\n2–2 of 3; next offset: 2' }
  ])
  expect((await related({ id: 'creature:1', offset: 20 })).content).toEqual([
    { type: 'text', text: '0–0 of 3; end' }
  ])
})

test('rejects malformed IDs, relation names, bounds and unknown properties', async () => {
  const results = await Promise.all(
    [
      { id: 'bad:x' },
      { id: 'item:' },
      { id: 1 },
      { id: 'item:1', rel: 'drop' },
      { id: 'item:1', limit: 0 },
      { id: 'item:1', limit: 101 },
      { id: 'item:1', limit: 1.5 },
      { id: 'item:1', offset: -1 },
      { id: 'item:1', offset: 1.5 },
      { id: 'item:1', extra: true }
    ].map(related)
  )

  for (const result of results) {
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).not.toContain('\\n')
  }
})

test('every relation and inverse filters the correct endpoint', async () => {
  await Promise.all(
    pairs.map(async ([forward, inverse], index) => {
      expect((await related({ id: `item:source${index}`, rel: forward })).content).toEqual([
        { type: 'text', text: `${forward} item:destination${index}\n1–1 of 1; end` }
      ])
      expect((await related({ id: `item:destination${index}`, rel: inverse })).content).toEqual([
        { type: 'text', text: `${inverse} item:source${index}\n1–1 of 1; end` }
      ])
    })
  )
})
