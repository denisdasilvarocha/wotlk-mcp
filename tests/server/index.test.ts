import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client, ProtocolErrorCode } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-test-'))
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'test', version: '1' })

function toolDescriptionLength(tool: Readonly<{ description?: string }>): number {
  return tool.description?.length ?? 0
}

function toolProperties(
  tool: Readonly<{ inputSchema: Readonly<{ properties?: Readonly<Record<string, unknown>> }> }>
): unknown[] {
  return Object.values(tool.inputSchema.properties ?? {})
}

beforeAll(async () => {
  initReference(database)
  unpackPackage(directory)

  const db = new DatabaseSync(database)

  db.exec(`CREATE TABLE world_example (name TEXT, description TEXT, empty TEXT, zero INTEGER);
    INSERT INTO world_example VALUES ('Example', 'first line' || char(10) || 'second line', '', 0);
    INSERT INTO record VALUES ('item:123', 'item', 'Example', 'world_example', 1, '', '')`)
  db.exec(`CREATE TABLE world_decoding (class INTEGER, subclass INTEGER, flags INTEGER, sentinel INTEGER, unknown INTEGER, signed INTEGER);
    INSERT INTO world_decoding VALUES (2, 3, 9, -1, 99, -2147483647);
    INSERT INTO record VALUES ('item:124', 'item', 'Decoding', 'world_decoding', 1, '', '');
    INSERT INTO enum_field VALUES
      ('world_decoding', 'subclass', 'Subclass', 0, 'class', 2),
      ('world_decoding', 'flags', 'Flags', 1, NULL, NULL),
      ('world_decoding', 'sentinel', 'Flags', 1, NULL, NULL),
      ('world_decoding', 'signed', 'Flags', 1, NULL, NULL),
      ('world_decoding', 'unknown', 'Subclass', 0, NULL, NULL);
    INSERT INTO enum_value VALUES ('Subclass', 3, 'AXE'), ('Flags', 1, 'KNOWN'), ('Flags', 2147483648, 'HIGH')`)
  db.close()
  await client.connect(packagedServer(directory, database))
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { force: true, recursive: true })
})

test('packaged server retrieves Offsets and reports missing IDs individually', async () => {
  const tools = await client.listTools()

  expect(tools.tools.map((tool: Readonly<{ name: string }>) => tool.name).toSorted()).toEqual([
    'get',
    'related',
    'search',
    'sql'
  ])

  const get = tools.tools.find((tool: Readonly<{ name: string }>) => tool.name === 'get')

  expect(get?.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: { ids: { maxItems: 20, minItems: 1 } }
  })
  expect(get?.annotations).toMatchObject({ openWorldHint: false, readOnlyHint: true })

  const search = tools.tools.find((tool: Readonly<{ name: string }>) => tool.name === 'search')
  const related = tools.tools.find((tool: Readonly<{ name: string }>) => tool.name === 'related')
  const sql = tools.tools.find((tool: Readonly<{ name: string }>) => tool.name === 'sql')

  expect(search?.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: {
      kind: { items: { enum: expect.arrayContaining(['item', 'offset']) as unknown } },
      limit: { default: 20, maximum: 100, minimum: 1 },
      offset: { default: 0, minimum: 0 }
    },
    required: ['query']
  })
  expect(related?.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: { rel: { enum: expect.arrayContaining(['drops', 'dropped by']) as unknown } },
    required: ['id']
  })
  expect(sql?.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: { limit: { default: 100, maximum: 1000, minimum: 1 } },
    required: ['query']
  })

  const result = await client.callTool({
    arguments: {
      ids: ['offset:Globals::PlayerName', 'offset:missing']
    },
    name: 'get'
  })

  expect(JSON.stringify(result)).toContain('va: 0x00C79D18')
  expect(JSON.stringify(result)).toContain('note: current player name')
  expect(JSON.stringify(result)).toContain('not found: offset:missing')
  expect(result.isError).not.toBe(true)
})

test('server explains itself within client description limits', async () => {
  const instructions = client.getInstructions()
  const { tools } = await client.listTools()

  expect(instructions).toBeTruthy()
  expect(client.getServerVersion()).toMatchObject({ title: 'WotLK 3.3.5a Reference' })
  // Claude Code truncates tool descriptions and server instructions beyond 2,048 characters.
  expect(
    Math.max(
      toolDescriptionLength({ description: instructions }),
      ...tools.map((tool: Readonly<{ description?: string }>) => toolDescriptionLength(tool))
    )
  ).toBeLessThanOrEqual(2048)

  for (const property of tools.flatMap(
    (
      tool: Readonly<{ inputSchema: Readonly<{ properties?: Readonly<Record<string, unknown>> }> }>
    ) => toolProperties(tool)
  )) {
    expect(property).toHaveProperty('description')
  }
})

test('invalid IDs and oversized batches are tool errors', async () => {
  const results = await Promise.all(
    [['bogus:x'], [], Array.from({ length: 21 }, () => 'offset:x')].map((ids: readonly string[]) =>
      client.callTool({ arguments: { ids }, name: 'get' })
    )
  )

  for (const result of results) {
    expect(result.isError).toBe(true)
  }

  for (const result of results) {
    expect(JSON.stringify(result)).toContain('ids')
    expect(JSON.stringify(result)).not.toContain('\\n')
  }

  const multiple = await client.callTool({
    arguments: { from: 0, ids: [] },
    name: 'get'
  })

  expect(multiple.isError).toBe(true)
  expect(JSON.stringify(multiple)).toContain('ids')
  expect(JSON.stringify(multiple)).toContain('from')
  expect(JSON.stringify(multiple)).not.toContain('\\n')
})

test('unknown tools are protocol errors, not tool results', async () => {
  await expect(client.callTool({ arguments: {}, name: 'nope' })).rejects.toMatchObject({
    code: ProtocolErrorCode.InvalidParams
  })
})

test('wide source rows retain full text and omit empty fields only in rendering', async () => {
  const result = await client.callTool({ arguments: { ids: ['item:123'] }, name: 'get' })

  expect(result.content).toEqual([
    { text: 'item:123\nname: Example\ndescription: first line\n  second line', type: 'text' }
  ])
})

test('get decodes conditional enums and retains unknown bits and sentinels while SQL stays raw', async () => {
  const get = await client.callTool({ arguments: { ids: ['item:124'] }, name: 'get' })

  expect(JSON.stringify(get)).toContain('subclass: 3 (AXE)')
  expect(JSON.stringify(get)).toContain('flags: 9 (KNOWN, 8)')
  expect(JSON.stringify(get)).toContain('sentinel: -1')
  expect(JSON.stringify(get)).toContain('signed: -2147483647 (KNOWN, HIGH)')
  expect(JSON.stringify(get)).toContain('unknown: 99')

  const sql = await client.callTool({
    arguments: { query: 'SELECT subclass, flags, sentinel FROM world_decoding' },
    name: 'sql'
  })

  expect(JSON.stringify(sql)).toContain('3\\t9\\t-1')
})

test('a newer schema major is rejected rather than substituted', async () => {
  const incompatible = path.join(directory, 'newer.sqlite')
  const db = new DatabaseSync(incompatible)

  db.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('schema_version', '2.0.0')"
  )
  db.close()

  const other = new Client({ name: 'test-newer', version: '1' })

  await other.connect(packagedServer(directory, incompatible))

  try {
    const result = await other.callTool({
      arguments: { ids: ['offset:Globals::PlayerName'] },
      name: 'get'
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('incompatible schema version 2.0.0')
  } finally {
    await other.close()
  }
})
