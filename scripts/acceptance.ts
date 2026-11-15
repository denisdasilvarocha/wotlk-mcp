import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as z from 'zod'

const kinds = [
  'spell',
  'talent',
  'itemset',
  'skillline',
  'map',
  'area',
  'faction',
  'class',
  'race',
  'achievement',
  'creature',
  'item',
  'quest',
  'gameobject',
  'fn',
  'event',
  'widget',
  'method',
  'cvar',
  'type',
  'cle',
  'template',
  'slash',
  'offset',
  'file'
]

const relations = [
  'drops',
  'dropped by',
  'starts',
  'started by',
  'ends',
  'ended by',
  'rewards',
  'rewarded by',
  'sells',
  'sold by',
  'teaches',
  'taught by',
  'casts',
  'cast by',
  'contains',
  'contained in',
  'grants',
  'granted by',
  'belongs to',
  'includes',
  'faction',
  'faction of',
  'spawns in',
  'spawns',
  'implemented by',
  'implements'
]

const fixture = z
  .strictObject({
    id: z.string().min(1),
    domain: z.enum(['lua', 'client', 'world', 'offsets']),
    citation: z.string().min(10),
    tool: z.enum(['search', 'get', 'related', 'sql']),
    args: z.record(z.string(), z.unknown()),
    contains: z.array(z.string().min(1)).min(1)
  })
  .superRefine((value, context) => {
    const identifier = z.string().regex(/^[a-z]+:.+$/)
    const page = {
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().nonnegative().optional()
    }
    const inputs = {
      search: z.strictObject({
        query: z.string().trim().min(1),
        kind: z.array(z.enum(kinds)).optional(),
        ...page
      }),
      get: z.strictObject({
        ids: z.array(identifier).min(1).max(20),
        from: z.number().int().positive().optional(),
        to: z.number().int().positive().optional()
      }),
      related: z.strictObject({ id: identifier, rel: z.enum(relations).optional(), ...page }),
      sql: z.strictObject({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional()
      })
    }
    const parsed = inputs[value.tool].safeParse(value.args)

    if (!parsed.success)
      context.addIssue({
        code: 'custom',
        message: `invalid ${value.tool} arguments: ${parsed.error.message}`
      })
  })

const approval = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unapproved') }),
  z.strictObject({
    status: z.literal('approved'),
    reviewer: z.string().trim().min(2),
    date: z.iso.date(),
    record: z.url(),
    fixtures_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    world_cases: z.array(z.string().min(1)).min(1)
  })
])

async function main(): Promise<void> {
  const [archive, database, fixtureFile] = process.argv.slice(2)

  if (!archive || !database || !fixtureFile || process.argv.length !== 5)
    throw new Error('usage: vpx scripts/acceptance.ts PACKAGE.tgz CANDIDATE.sqlite FIXTURES.json')

  let fixtureBytes: Buffer
  let fixtures

  try {
    fixtureBytes = readFileSync(fixtureFile)
    fixtures = z
      .array(fixture)
      .min(30)
      .parse(JSON.parse(fixtureBytes.toString('utf8')))
    assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length, 'duplicate fixture ID')

    for (const domain of ['lua', 'client', 'world', 'offsets'])
      assert(
        fixtures.some((f) => f.domain === domain),
        `missing ${domain} fixtures`
      )

    for (const tool of ['search', 'get', 'related', 'sql'])
      assert(
        fixtures.some((f) => f.tool === tool),
        `missing ${tool} fixtures`
      )
  } catch (error) {
    throw new Error(`invalid fixture file: ${String(error)}`, { cause: error })
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-acceptance-'))
  const client = new Client({ name: 'release-acceptance', version: '1' })
  const failures: string[] = []

  try {
    execFileSync('tar', ['-xzf', path.resolve(archive), '-C', dir])

    const root = path.join(dir, 'package')
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

    assert.equal(manifest.name, 'wotlk-mcp')

    const { bin: declaredBin } = manifest
    let bin = declaredBin?.['wotlk-mcp']

    if (typeof declaredBin === 'string') bin = declaredBin
    assert.equal(typeof bin, 'string', 'package executable missing')

    const executable = path.resolve(root, bin)
    let linkType: 'junction' | 'dir' = 'dir'

    assert(executable.startsWith(root + path.sep), 'invalid executable path')

    if (process.platform === 'win32') linkType = 'junction'
    symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), linkType)
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [executable],
        env: { ...process.env, WOTLK_MCP_DB: path.resolve(database) }
      })
    )

    const capabilities = client.getServerCapabilities()

    assert(!capabilities?.resources && !capabilities?.prompts, 'resources or prompts are exposed')

    const { tools } = await client.listTools()

    assert.deepEqual(tools.map((t) => t.name).toSorted(), ['get', 'related', 'search', 'sql'])

    for (const tool of tools) {
      assert(
        tool.description && tool.description.length <= 600,
        `${tool.name}: description missing or too long`
      )
      assert.equal(tool.annotations?.readOnlyHint, true)
      assert.equal(tool.annotations?.openWorldHint, false)
      assert(!tool.outputSchema, `${tool.name}: output schema exposed`)
      assert.equal(tool.inputSchema.type, 'object')
      assert.equal(tool.inputSchema.additionalProperties, false)
    }

    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]))
    const bounds = z.object({ minimum: z.number(), maximum: z.number() })
    const search = z
      .object({ kind: z.object({ items: z.object({ enum: z.array(z.string()) }) }), limit: bounds })
      .parse(byName.search.properties)
    const related = z
      .object({ rel: z.object({ enum: z.array(z.string()) }), limit: bounds })
      .parse(byName.related.properties)
    const get = z
      .object({ ids: z.object({ minItems: z.number(), maxItems: z.number() }) })
      .parse(byName.get.properties)
    const sql = z.object({ limit: bounds }).parse(byName.sql.properties)

    assert.deepEqual(search.kind.items.enum, kinds)
    assert.deepEqual(related.rel.enum, relations)
    assert.deepEqual(byName.search.required, ['query'])
    assert.deepEqual(byName.get.required, ['ids'])
    assert.deepEqual(byName.related.required, ['id'])
    assert.deepEqual(byName.sql.required, ['query'])
    assert.equal(get.ids.minItems, 1)
    assert.equal(get.ids.maxItems, 20)
    assert.equal(search.limit.minimum, 1)
    assert.equal(search.limit.maximum, 100)
    assert.equal(related.limit.minimum, 1)
    assert.equal(related.limit.maximum, 100)
    assert.equal(sql.limit.minimum, 1)
    assert.equal(sql.limit.maximum, 1000)
    await Promise.all(
      fixtures.map(async (item) => {
        try {
          const result = await client.callTool({ name: item.tool, arguments: item.args })

          assert.notEqual(result.isError, true, JSON.stringify(result))
          assert(!('structuredContent' in result), 'structuredContent exposed')
          assert(
            Array.isArray(result.content) &&
              result.content.length > 0 &&
              result.content.every((part) => part.type === 'text' && typeof part.text === 'string'),
            'non-text result'
          )

          const text = result.content.map((part) => part.text).join('\n')

          for (const expected of item.contains)
            assert(
              text.includes(expected),
              `missing ${JSON.stringify(expected)} in ${JSON.stringify(text)}`
            )

          console.log(`PASS ${item.id}`)
        } catch (error) {
          failures.push(`${item.id}: ${String(error)} (${item.citation})`)
        }
      })
    )
  } finally {
    await client.close()
    rmSync(dir, { recursive: true, force: true })
  }

  const recordPath = fileURLToPath(
    new URL('../data/world-acceptance-approval.json', import.meta.url)
  )
  const record = approval.parse(JSON.parse(readFileSync(recordPath, 'utf8')))

  if (record.status !== 'approved')
    failures.push(
      'UNAPPROVED World Data: maintainer review and durable approval of exact cases are required; see docs/world-data-facts.md and #45'
    )
  else {
    const digest = createHash('sha256').update(fixtureBytes).digest('hex')

    if (
      record.fixtures_sha256 !== digest ||
      JSON.stringify(record.world_cases.toSorted()) !==
        JSON.stringify(
          fixtures
            .filter((f) => f.domain === 'world')
            .map((f) => f.id)
            .toSorted()
        )
    )
      failures.push(
        'UNAPPROVED World Data: approval does not cover these exact fixtures and case IDs'
      )
  }

  if (failures.length) throw new Error(failures.join('\n'))
}

try {
  await main()
} catch (error: unknown) {
  console.error(error)
  process.exitCode = 1
}
