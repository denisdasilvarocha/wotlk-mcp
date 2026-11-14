import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-test-'))
const packaged = path.join(directory, 'package')
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'test', version: '1' })

beforeAll(async () => {
  execFileSync('vpx', ['scripts/build-reference.ts', database], { stdio: 'pipe' })
  execFileSync('vp', ['pm', 'pack', '--pack-destination', directory], { stdio: 'pipe' })
  const archive = readdirSync(directory).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive not created')
  execFileSync('tar', ['-xzf', path.join(directory, archive), '-C', directory])
  symlinkSync(path.resolve('node_modules'), path.join(packaged, 'node_modules'), 'dir')
  const db = new DatabaseSync(database)
  db.exec(`CREATE TABLE world_example (name TEXT, description TEXT, empty TEXT, zero INTEGER);
    INSERT INTO world_example VALUES ('Example', 'first line' || char(10) || 'second line', '', 0);
    INSERT INTO record VALUES ('item:123', 'item', 'Example', 'world_example', 1, '', '')`)
  db.close()
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packaged, 'dist/index.mjs')],
      env: { ...process.env, WOTLK_MCP_DB: database }
    })
  )
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { recursive: true, force: true })
})

test('packaged server retrieves Offsets and reports missing IDs individually', async () => {
  const tools = await client.listTools()
  expect(tools.tools.map((tool) => tool.name)).toEqual(['get'])
  expect(tools.tools[0]?.inputSchema).toMatchObject({
    properties: { ids: { minItems: 1, maxItems: 20 } },
    additionalProperties: false
  })
  expect(tools.tools[0]?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
  const result = await client.callTool({
    name: 'get',
    arguments: {
      ids: ['offset:Globals::PlayerName', 'offset:missing']
    }
  })
  expect(JSON.stringify(result)).toContain('va: 0x00C79D18')
  expect(JSON.stringify(result)).toContain('note: current player name')
  expect(JSON.stringify(result)).toContain('not found: offset:missing')
  expect(result.isError).not.toBe(true)
})

test('invalid IDs and oversized batches are tool errors', async () => {
  const results = await Promise.all(
    [['bogus:x'], [], Array(21).fill('offset:x')].map((ids) =>
      client.callTool({ name: 'get', arguments: { ids } })
    )
  )
  for (const result of results) expect(result.isError).toBe(true)
  for (const result of results) {
    expect(JSON.stringify(result)).toContain('valid kinds:')
    expect(JSON.stringify(result)).not.toContain('\\n')
  }
})

test('wide source rows retain full text and omit empty fields only in rendering', async () => {
  const result = await client.callTool({ name: 'get', arguments: { ids: ['item:123'] } })
  expect(result.content).toEqual([
    { type: 'text', text: 'item:123\nname: Example\ndescription: first line\n  second line' }
  ])
})

test('invalid local overrides are actionable errors', async () => {
  const other = new Client({ name: 'test-invalid', version: '1' })
  await other.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packaged, 'dist/index.mjs')],
      env: { ...process.env, WOTLK_MCP_DB: path.join(directory, 'missing.sqlite') }
    })
  )
  try {
    const result = await other.callTool({
      name: 'get',
      arguments: { ids: ['offset:Globals::PlayerName'] }
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('invalid WOTLK_MCP_DB')
  } finally {
    await other.close()
  }
})

test('a newer schema major is rejected rather than substituted', async () => {
  const incompatible = path.join(directory, 'newer.sqlite')
  const db = new DatabaseSync(incompatible)
  db.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('schema_version', '2.0.0')"
  )
  db.close()
  const other = new Client({ name: 'test-newer', version: '1' })
  await other.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packaged, 'dist/index.mjs')],
      env: { ...process.env, WOTLK_MCP_DB: incompatible }
    })
  )
  try {
    const result = await other.callTool({
      name: 'get',
      arguments: { ids: ['offset:Globals::PlayerName'] }
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('incompatible schema version 2.0.0')
  } finally {
    await other.close()
  }
})
