import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-'))
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'sql-test', version: '1' })

beforeAll(async () => {
  if (
    process.env.WOTLK_TEST_NODE !== undefined &&
    process.env.WOTLK_TEST_NODE !== '' &&
    process.version !== process.env.WOTLK_TEST_NODE
  ) {
    throw new Error(`Expected Node ${process.env.WOTLK_TEST_NODE}, found ${process.version}`)
  }

  initReference(database)

  const db = new DatabaseSync(database)

  db.exec("CREATE TABLE world_sql (value TEXT); INSERT INTO world_sql VALUES ('original')")
  db.close()
  unpackPackage(directory)
  await client.connect(packagedServer(directory, database))
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { force: true, recursive: true })
})

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

function sql(query: string, limit?: number): ReturnType<Client['callTool']> {
  return client.callTool({ arguments: { limit, query }, name: 'sql' })
}

test('packed SQL preserves columns, values, escaping and large integers', async () => {
  const tools = await client.listTools()

  expect(
    tools.tools.find((tool: { readonly name: string }) => tool.name === 'sql')?.annotations
      ?.readOnlyHint
  ).toBe(true)

  const result = await sql(
    "SELECT 'a' || char(9) || 'b' || char(10) || 'c' || char(13) || char(92) AS x, NULL AS n, 9223372036854775807 AS big, 'NULL' AS literal, x'00ff' AS blob"
  )

  expect(result.isError).not.toBe(true)
  expect(text(result)).toBe(
    'x\tn\tbig\tliteral\tblob\na\\tb\\nc\\r\\\\\tNULL\t9223372036854775807\t\\NULL\t\\x00ff'
  )
  expect(text(await sql('SELECT 1 AS same, 2 AS same'))).toBe('same\tsame\n1\t2')
  expect(text(await sql('SELECT 1 AS "NULL"'))).toBe('NULL\n1')
  expect(text(await sql("SELECT ';' AS semicolon; -- harmless trailing comment"))).toBe(
    'semicolon\n;'
  )
})

test('SQL permits only the specified direct and table-valued discovery pragmas', async () => {
  const allowed = [
    "PRAGMA table_info('world_sql')",
    "PRAGMA table_xinfo('world_sql')",
    'PRAGMA table_list',
    "PRAGMA index_list('world_sql')",
    "PRAGMA foreign_key_list('world_sql')",
    "SELECT name FROM pragma_table_info('world_sql')",
    "SELECT name FROM pragma_table_xinfo('world_sql')",
    'SELECT name FROM pragma_table_list',
    "SELECT name FROM pragma_index_list('world_sql')",
    "SELECT * FROM pragma_foreign_key_list('world_sql')",
    'SELECT name FROM sqlite_schema'
  ]
  const allowedResults = await Promise.all(allowed.map((query) => sql(query)))

  for (const result of allowedResults) {
    expect(result.isError).not.toBe(true)
  }

  const denied = [
    "INSERT INTO world_sql VALUES ('modified')",
    "ATTACH DATABASE ':memory:' AS other",
    'DETACH DATABASE main',
    'PRAGMA database_list',
    'SELECT * FROM pragma_database_list',
    'PRAGMA user_version',
    'SELECT * FROM pragma_user_version',
    'PRAGMA writable_schema=ON',
    "SELECT load_extension('anything')",
    'SELECT 1; SELECT 2',
    'SELECT 1; -- comment\n DELETE FROM world_sql',
    'PRAGMA compile_options',
    'SELECT * FROM pragma_compile_options',
    'PRAGMA function_list',
    'SELECT * FROM pragma_function_list',
    'PRAGMA module_list',
    'SELECT * FROM pragma_pragma_list',
    "SELECT readfile('/etc/passwd')",
    'CREATE TEMP TABLE other(x)',
    'VACUUM',
    'REINDEX',
    'BEGIN',
    'WITH c AS (SELECT 1) DELETE FROM world_sql',
    "SELECT * FROM pragma_table_info('world_sql'); ATTACH DATABASE ':memory:' AS x"
  ]
  const deniedResults = await Promise.all(denied.map((query) => sql(query)))

  for (const result of deniedResults) {
    expect(result.isError).toBe(true)
  }
  expect((await sql('PRAGMA nonexistent_setting')).isError).toBe(true)
  expect((await sql('SELECT name FROM other.sqlite_schema')).isError).toBe(true)
  expect(text(await sql('SELECT value FROM world_sql'))).toBe('value\noriginal')
}, 15000)

test('SQL accepts only whitespace and closed comments after one statement', async () => {
  const accepted = await sql('SELECT 1; \t\r\n\u00a0/* block */ -- line\r\n-- end')

  expect(accepted.isError).not.toBe(true)
  expect(text(accepted)).toBe('1\n1')

  const tails = [
    `--${'\r\n--'.repeat(20000)}\r\nSELECT 2`,
    `/*${'*//*'.repeat(20000)}*/SELECT 2`,
    '/* unterminated'
  ]
  const results = await Promise.all(tails.map((tail) => sql(`SELECT 1; ${tail}`)))

  for (const result of results) {
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('SQL requires exactly one statement')
  }
}, 15000)

test('SQL validates row limits and reports complete-row truncation within output cap', async () => {
  const invalidLimits = await Promise.all([0, 1001, 1.5].map((limit) => sql('SELECT 1', limit)))

  for (const result of invalidLimits) {
    expect(result.isError).toBe(true)
  }
  expect(text(await sql('SELECT 1 AS n', 1))).toBe('n\n1')

  const defaultLimit = text(
    await sql(
      'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<101) SELECT x FROM n'
    )
  )

  expect(defaultLimit.endsWith('99\n100\n[truncated: row limit]')).toBe(true)
  expect(text(await sql('SELECT 1 AS n UNION ALL SELECT 2', 1))).toBe(
    'n\n1\n[truncated: row limit]'
  )

  const result = text(
    await sql("SELECT printf('%.*c', 31990, 'x') AS value UNION ALL SELECT 'second'")
  )

  expect(result.length).toBeLessThanOrEqual(32000)
  expect(result).toContain('[truncated: output limit]')
  expect(result).not.toContain('second')
  expect(text(await sql("SELECT printf('%.*c', 33000, 'x') AS value"))).toBe(
    'value\n[truncated: output limit]'
  )

  const full = text(
    await sql(
      'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) SELECT x FROM n',
      1000
    )
  )

  expect(full.endsWith('999\n1000\n[truncated: row limit]')).toBe(true)
})

test('SQL times out without blocking stdio and recovers', async () => {
  const started = Date.now()
  const pending = sql(
    'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n'
  )
  const discovery = await client.listTools()

  expect(Date.now() - started).toBeLessThan(3000)
  expect(discovery.tools.some((tool: { readonly name: string }) => tool.name === 'sql')).toBe(true)
  expect(text(await sql('SELECT 7 AS concurrent'))).toBe('concurrent\n7')

  const result = await pending

  expect(Date.now() - started).toBeGreaterThanOrEqual(4900)
  expect(Date.now() - started).toBeLessThan(9000)
  expect(result.isError).toBe(true)
  expect(text(result)).toMatch(/timed out/iu)
  expect(text(await sql('SELECT 42 AS answer'))).toBe('answer\n42')
}, 15000)
