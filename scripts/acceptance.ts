import { approvalFailure, kinds, relations } from './acceptance-constants.ts'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as z from 'zod'

const fixture = z
  .strictObject({
    args: z.record(z.string(), z.unknown()),
    citation: z.string().min(10),
    contains: z.array(z.string().min(1)).min(1),
    domain: z.enum(['lua', 'client', 'world', 'offsets']),
    id: z.string().min(1),
    tool: z.enum(['search', 'get', 'related', 'sql'])
  })
  .superRefine(
    (
      value: Readonly<{
        args: Readonly<Record<string, unknown>>
        tool: 'search' | 'get' | 'related' | 'sql'
      }>,
      context: Readonly<Pick<z.RefinementCtx, 'addIssue'>>
    ) => {
      const identifier = z.string().regex(/^[a-z]+:.+$/u)
      const page = {
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().nonnegative().optional()
      }
      const inputs = {
        get: z.strictObject({
          from: z.number().int().positive().optional(),
          ids: z.array(identifier).min(1).max(20),
          to: z.number().int().positive().optional()
        }),
        related: z.strictObject({ id: identifier, rel: z.enum(relations).optional(), ...page }),
        search: z.strictObject({
          kind: z.array(z.enum(kinds)).optional(),
          query: z.string().trim().min(1),
          ...page
        }),
        sql: z.strictObject({
          limit: z.number().int().min(1).max(1000).optional(),
          query: z.string().min(1)
        })
      }
      const parsed = inputs[value.tool].safeParse(value.args)

      if (!parsed.success) {
        context.addIssue({
          code: 'custom',
          message: `invalid ${value.tool} arguments: ${parsed.error.message}`
        })
      }
    }
  )

type Fixture = {
  readonly args: Readonly<Record<string, unknown>>
  readonly citation: string
  readonly contains: readonly string[]
  readonly domain: string
  readonly id: string
  readonly tool: string
}

function loadFixtures(fixtureFile: string): { bytes: Buffer; fixtures: readonly Fixture[] } {
  try {
    const bytes = readFileSync(fixtureFile)
    const fixtures: readonly Fixture[] = z
      .array(fixture)
      .min(30)
      .parse(JSON.parse(bytes.toString('utf8')))
    assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length, 'duplicate fixture ID')

    for (const domain of ['lua', 'client', 'world', 'offsets']) {
      assert.ok(
        fixtures.some((f) => f.domain === domain),
        `missing ${domain} fixtures`
      )
    }

    for (const tool of ['search', 'get', 'related', 'sql']) {
      assert.ok(
        fixtures.some((f) => f.tool === tool),
        `missing ${tool} fixtures`
      )
    }
    return { bytes, fixtures }
  } catch (error) {
    throw new Error(`invalid fixture file: ${String(error)}`, { cause: error })
  }
}

function unpack(archive: string, dir: string): string {
  // stdin, not -f: GNU tar (Git Bash on Windows) reads "D:\..." as a remote host.
  execFileSync('tar', ['-xz', '-C', dir], { input: readFileSync(path.resolve(archive)) })

  const root = path.join(dir, 'package')
  const manifest = z
    .object({
      bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      name: z.string()
    })
    .parse(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')))

  assert.equal(manifest.name, 'wotlk-mcp')

  const { bin: declaredBin } = manifest
  let bin = typeof declaredBin === 'object' ? declaredBin['wotlk-mcp'] : undefined

  if (typeof declaredBin === 'string') {
    bin = declaredBin
  }
  assert.equal(typeof bin, 'string', 'package executable missing')

  const executable = path.resolve(root, bin ?? '')
  let linkType: 'junction' | 'dir' = 'dir'

  assert.ok(executable.startsWith(root + path.sep), 'invalid executable path')

  if (process.platform === 'win32') {
    linkType = 'junction'
  }
  symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), linkType)
  return executable
}

async function checkCapabilities(
  client: Readonly<Pick<Client, 'getServerCapabilities' | 'listTools'>>
): Promise<void> {
  const capabilities = client.getServerCapabilities()

  assert.ok(!capabilities?.resources && !capabilities?.prompts, 'resources or prompts are exposed')

  const { tools } = await client.listTools()

  assert.deepEqual(tools.map((t: Readonly<{ name: string }>) => t.name).toSorted(), [
    'get',
    'related',
    'search',
    'sql'
  ])

  for (const tool of tools) {
    assert.ok(
      tool.description !== undefined && tool.description !== '' && tool.description.length <= 1600,
      `${tool.name}: description missing or too long`
    )
    assert.equal(tool.annotations?.readOnlyHint, true)
    assert.equal(tool.annotations?.openWorldHint, false)
    assert.ok(!tool.outputSchema, `${tool.name}: output schema exposed`)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
  }

  checkToolSchemas(tools)
}

function checkToolSchemas(
  tools: readonly Readonly<{
    name: string
    inputSchema: Readonly<{ properties?: unknown; required?: unknown }>
  }>[]
): void {
  const byName = Object.fromEntries(
    tools.map(
      (
        t: Readonly<{
          name: string
          inputSchema: Readonly<{ properties?: unknown; required?: unknown }>
        }>
      ) => [t.name, t.inputSchema]
    )
  )
  const bounds = z.object({ maximum: z.number(), minimum: z.number() })
  const search = z
    .object({ kind: z.object({ items: z.object({ enum: z.array(z.string()) }) }), limit: bounds })
    .parse(byName.search.properties)
  const related = z
    .object({ limit: bounds, rel: z.object({ enum: z.array(z.string()) }) })
    .parse(byName.related.properties)
  const get = z
    .object({ ids: z.object({ maxItems: z.number(), minItems: z.number() }) })
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
}

async function runFixtures(
  client: Readonly<Pick<Client, 'callTool'>>,
  fixtures: readonly Fixture[]
): Promise<string[]> {
  const failures: string[] = []
  await Promise.all(
    fixtures.map(async (item) => {
      try {
        const result = await client.callTool({ arguments: item.args, name: item.tool })

        assert.notEqual(result.isError, true, JSON.stringify(result))
        assert.ok(!('structuredContent' in result), 'structuredContent exposed')
        assert.ok(
          Array.isArray(result.content) &&
            result.content.length > 0 &&
            result.content.every(
              (part: Readonly<{ type: string; text?: unknown }>) =>
                part.type === 'text' && typeof part.text === 'string'
            ),
          'non-text result'
        )

        const text = result.content
          .filter((part: Readonly<{ type: string }>) => part.type === 'text')
          .map((part: Readonly<{ type: string; text?: unknown }>) => part.text)
          .join('\n')

        for (const expected of item.contains) {
          assert.ok(
            text.includes(expected),
            `missing ${JSON.stringify(expected)} in ${JSON.stringify(text)}`
          )
        }

        console.log(`PASS ${item.id}`)
      } catch (error) {
        failures.push(`${item.id}: ${String(error)} (${item.citation})`)
      }
    })
  )
  return failures
}

async function main(): Promise<void> {
  const [archive, database, fixtureFile] = process.argv.slice(2)

  if (!archive || !database || !fixtureFile || process.argv.length !== 5) {
    throw new Error('usage: vpx scripts/acceptance.ts PACKAGE.tgz CANDIDATE.sqlite FIXTURES.json')
  }

  const { bytes, fixtures } = loadFixtures(fixtureFile)
  const dir = mkdtempSync(path.join(tmpdir(), 'wotlk-acceptance-'))
  const client = new Client({ name: 'release-acceptance', version: '1' })
  let failures: string[]

  try {
    const executable = unpack(archive, dir)
    await client.connect(
      new StdioClientTransport({
        args: [executable],
        command: process.execPath,
        env: { ...process.env, WOTLK_MCP_DB: path.resolve(database) }
      })
    )
    await checkCapabilities(client)
    failures = await runFixtures(client, fixtures)
  } finally {
    await client.close()
    rmSync(dir, { force: true, recursive: true })
  }

  const failure = approvalFailure(() => createHash('sha256').update(bytes).digest('hex'), fixtures)

  if (failure !== undefined) {
    failures.push(failure)
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'))
  }
}

try {
  await main()
} catch (error: unknown) {
  console.error(error)
  process.exitCode = 1
}
