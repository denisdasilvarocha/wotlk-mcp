import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

import { schema } from '../src/schema.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-search-'))
const dbPath = path.join(dir, 'reference.sqlite')
const client = new Client({ name: 'search-test', version: '1' })

beforeAll(async () => {
  const db = new DatabaseSync(dbPath)
  db.exec(schema)
  db.exec("INSERT INTO meta VALUES ('schema_version', '1.0.0')")
  const insert = db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')
  const fts = db.prepare('INSERT INTO record_fts VALUES (?, ?, ?)')
  const rows = [
    ['spell:42', 'spell', 'Fire Bolt', '', 'Rank 2'],
    ['item:42', 'item', 'Other', '', 'level 20, quality 3'],
    ['quest:9', 'quest', 'Fire Bolt', '', 'level 9, Forest'],
    ['creature:7', 'creature', 'Fire Boltling', '', 'levels 1-2, Wolf'],
    ['fn:FireBolt', 'fn', 'Big Fire Bolt', '', 'Combat'],
    ['event:TEST', 'event', 'Fire Event', 'launches bolt now', 'Events'],
    ['item:3', 'item', '100%_safe', 'literal symbols', ''],
    ['item:4', 'item', '100XXsafe', '', ''],
    ['item:5', 'item', 'ab', '', ''],
    ['item:6', 'item', 'abc', '', ''],
    ['item:7', 'item', 'xxx', 'ab', ''],
    ['item:8', 'item', 'dragon', '', ''],
    ['item:9', 'item', 'dracon', '', ''],
    ['item:10', 'item', 'dragons', '', ''],
    ['item:11', 'item', 'Quote "AND" -star*', '', '']
  ]
  for (const [id, kind, name, description, hint] of rows) {
    insert.run(id, kind, name, 'world_example', 1, description, hint)
    fts.run(id, name, description)
  }
  db.close()
  execFileSync('vp', ['pm', 'pack', '--pack-destination', dir], { stdio: 'pipe' })
  const archive = readdirSync(dir).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive not created')
  execFileSync('tar', ['-xzf', path.join(dir, archive), '-C', dir])
  symlinkSync(path.resolve('node_modules'), path.join(dir, 'package/node_modules'), 'dir')
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(dir, 'package/dist/index.mjs')],
      env: { ...process.env, WOTLK_MCP_DB: dbPath }
    })
  )
})
afterAll(async () => {
  await client.close()
  rmSync(dir, { recursive: true, force: true })
})

async function search(args: Record<string, unknown>): ReturnType<typeof client.callTool> {
  return client.callTool({ name: 'search', arguments: args })
}
async function text(args: Record<string, unknown>): Promise<string> {
  const result = await search(args)
  expect(result.isError).not.toBe(true)
  if (!Array.isArray(result.content)) throw new Error('Missing search content')
  const [content] = result.content
  if (!content || typeof content.text !== 'string') throw new Error('Missing search text')
  return content.text
}
function ids(output: string): (string | undefined)[] {
  return output
    .split('\n')
    .filter((line) => /^[a-z]+:/.test(line))
    .map((line) => line.split(' ')[0])
}

test('normal tiers, hints, IDs, filtering and pagination are deterministic', async () => {
  const all = await text({ query: 'Fire Bolt' })
  expect(ids(all)).toEqual(['quest:9', 'spell:42', 'creature:7', 'fn:FireBolt', 'event:TEST'])
  expect(all).toContain('Rank 2')
  expect(all).toContain('launches bolt now')
  expect(ids(await text({ query: '42' }))).toEqual(['item:42', 'spell:42'])
  expect(ids(await text({ query: 'spell:42' }))).toEqual(['spell:42'])
  expect(ids(await text({ query: 'Fire Bolt', kind: ['fn', 'spell'] }))).toEqual([
    'spell:42',
    'fn:FireBolt'
  ])
  const page = await text({ query: 'Fire Bolt', limit: 2, offset: 2 })
  expect(ids(page)).toEqual(['creature:7', 'fn:FireBolt'])
  expect(page).toMatch(/5/)
  expect(page).toContain('3–4 of 5; next offset: 4')
  expect(await text({ query: 'Fire Bolt', offset: 99 })).toContain('0–0 of 5; end')
  expect((await text({ query: 'Fire Bolt', offset: 99 })).toLowerCase()).not.toContain('fuzzy')
})

test('punctuation, short queries and fuzzy fallback stay literal', async () => {
  expect(ids(await text({ query: '100%_safe' }))).toEqual(['item:3'])
  expect(ids(await text({ query: '"AND" -star*' }))).toEqual(['item:11'])
  expect(ids(await text({ query: '100%_safe', kind: ['quest'] }))).toEqual([])
  expect(ids(await text({ query: '42', kind: ['spell'] }))).toEqual(['spell:42'])
  expect(ids(await text({ query: 'Fire Bolt', kind: [] }))).toEqual([])
  expect(ids(await text({ query: 'ab' }))).toEqual(['item:5', 'item:6'])
  const fuzzy = await text({ query: 'dragn' })
  expect(ids(fuzzy)).toEqual(['item:8', 'item:10', 'item:9'])
  expect(await text({ query: 'dragn', limit: 1, offset: 1 })).toContain(
    'Fuzzy: 2–2 of 3; next offset: 2'
  )
  expect(fuzzy.toLowerCase()).toContain('fuzzy')
  expect((await search({ query: 'ab', kind: ['file'] })).isError).toBe(true)
  const invalid = await Promise.all(
    [
      { query: '' },
      { query: 'x', kind: ['invalid'] },
      { query: 'x', limit: 0 },
      { query: 'x', offset: -1 }
    ].map((args) => search(args))
  )
  for (const result of invalid) expect(result.isError).toBe(true)
})
