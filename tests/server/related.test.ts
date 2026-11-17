import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

import { linkWriter } from '../../build/links/insert.ts'
import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'

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
] as const

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

  const addLink = linkWriter(db)

  for (const row of db.prepare('SELECT chance FROM world_evidence').all()) {
    addLink('creature:1', 'drops', 'item:2', String(row.chance))
  }

  addLink('creature:1', 'drops', 'item:10')
  addLink('creature:1', 'starts', 'quest:1')
  addLink('quest:1', 'rewards', 'item:2', 'choice')

  const insert = db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')

  for (const [index, [relation]] of pairs.entries()) {
    const destination = `item:destination${index}`
    const source = `item:source${index}`

    insert.run(source, 'item', source, 'world_evidence', 1, '', '')
    insert.run(destination, 'item', destination, 'world_evidence', 1, '', '')
    addLink(source, relation, destination)
  }

  db.close()
  await client.connect(packagedServer(directory, database))
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { force: true, recursive: true })
})

function related(args: Readonly<Record<string, unknown>>): ReturnType<typeof client.callTool> {
  return client.callTool({ arguments: args, name: 'related' })
}

test('related is discoverable with all forward and inverse names', async () => {
  const tool = (await client.listTools()).tools.find(
    (entry: { readonly name: string }) => entry.name === 'related'
  )

  expect(tool?.annotations).toMatchObject({ openWorldHint: false, readOnlyHint: true })
  expect(tool?.inputSchema.properties?.rel).toMatchObject({
    enum: pairs.flat()
  })
})

test('navigates and filters both directions with distinct sorted notes', async () => {
  expect((await related({ id: 'creature:1' })).content).toEqual([
    { text: 'drops item:10\ndrops item:2 (25%; 5%)\nstarts quest:1\n1–3 of 3; end', type: 'text' }
  ])
  expect((await related({ id: 'item:2' })).content).toEqual([
    {
      text: 'dropped by creature:1 (25%; 5%)\nrewarded by quest:1 (choice)\n1–2 of 2; end',
      type: 'text'
    }
  ])
  expect((await related({ id: 'item:2', rel: 'dropped by' })).content).toEqual([
    { text: 'dropped by creature:1 (25%; 5%)\n1–1 of 1; end', type: 'text' }
  ])
  expect((await related({ id: 'item:2', rel: 'drops' })).content).toEqual([
    { text: '0–0 of 0; end', type: 'text' }
  ])
  expect((await related({ id: 'offset:missing' })).content).toEqual([
    { text: '0–0 of 0; end', type: 'text' }
  ])
})

test('paginates the sorted neighborhood including offsets past its end', async () => {
  expect((await related({ id: 'creature:1', limit: 1, offset: 1 })).content).toEqual([
    { text: 'drops item:2 (25%; 5%)\n2–2 of 3; next offset: 2', type: 'text' }
  ])
  expect((await related({ id: 'creature:1', offset: 20 })).content).toEqual([
    { text: '0–0 of 3; end', type: 'text' }
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
      { extra: true, id: 'item:1' }
    ].map(
      (
        args: Readonly<{
          id: string | number
          rel?: string
          limit?: number
          offset?: number
          extra?: boolean
        }>
      ) => related(args)
    )
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
        { text: `${forward} item:destination${index}\n1–1 of 1; end`, type: 'text' }
      ])
      expect((await related({ id: `item:destination${index}`, rel: inverse })).content).toEqual([
        { text: `${inverse} item:source${index}\n1–1 of 1; end`, type: 'text' }
      ])
    })
  )
})
