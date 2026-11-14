import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-'))
const packaged = path.join(directory, 'package')
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'sql-test', version: '1' })

beforeAll(async () => {
  execFileSync('vpx', ['scripts/build-reference.ts', database], { stdio: 'pipe' })
  const db = new DatabaseSync(database)
  db.exec("CREATE TABLE world_sql (value TEXT); INSERT INTO world_sql VALUES ('original')")
  db.close()
  execFileSync('vp', ['pm', 'pack', '--pack-destination', directory], { stdio: 'pipe' })
  const archive = readdirSync(directory).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive not created')
  execFileSync('tar', ['-xzf', path.join(directory, archive), '-C', directory])
  expect(readdirSync(path.join(packaged, 'dist'))).toContain('sql-worker.mjs')
  symlinkSync(path.resolve('node_modules'), path.join(packaged, 'node_modules'), 'dir')
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packaged, 'dist/index.mjs')],
    env: { ...process.env, WOTLK_MCP_DB: database }
  }))
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { recursive: true, force: true })
})

async function sql(query: string, limit?: number) {
  return client.callTool({ name: 'sql', arguments: { query, ...(limit === undefined ? {} : { limit }) } })
}

function text(result: Awaited<ReturnType<typeof sql>>): string {
  const content = result.content
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected text')
  return String(content[0].text)
}

test('packed SQL preserves columns, values, escaping and large integers', async () => {
  const tools = await client.listTools()
  expect(tools.tools.find((tool) => tool.name === 'sql')?.annotations?.readOnlyHint).toBe(true)
  const result = await sql("SELECT 'a' || char(9) || 'b' || char(10) || 'c' || char(13) || char(92) AS x, NULL AS n, 9223372036854775807 AS big, 'NULL' AS literal, x'00ff' AS blob")
  expect(result.isError).not.toBe(true)
  expect(text(result)).toBe('x\tn\tbig\tliteral\tblob\na\\tb\\nc\\r\\\\\tNULL\t9223372036854775807\t\\NULL\t\\x00ff')
  expect(text(await sql("SELECT 1 AS same, 2 AS same"))).toBe('same\tsame\n1\t2')
  expect(text(await sql("SELECT ';' AS semicolon; -- harmless trailing comment"))).toBe('semicolon\n;')
})

test('SQL permits only the specified direct and table-valued discovery pragmas', async () => {
  for (const query of ["PRAGMA table_info('world_sql')", "PRAGMA table_xinfo('world_sql')", 'PRAGMA table_list', "PRAGMA index_list('world_sql')", "PRAGMA foreign_key_list('world_sql')", "SELECT name FROM pragma_table_info('world_sql')", "SELECT name FROM pragma_table_xinfo('world_sql')", 'SELECT name FROM pragma_table_list', "SELECT name FROM pragma_index_list('world_sql')", "SELECT * FROM pragma_foreign_key_list('world_sql')", 'SELECT name FROM sqlite_schema']) {
    const result = await sql(query)
    expect(result.isError, query).not.toBe(true)
  }
  for (const query of ["INSERT INTO world_sql VALUES ('modified')", "ATTACH DATABASE ':memory:' AS other", 'DETACH DATABASE main', 'PRAGMA database_list', 'SELECT * FROM pragma_database_list', 'PRAGMA user_version', 'SELECT * FROM pragma_user_version', 'PRAGMA writable_schema=ON', "SELECT load_extension('anything')", 'SELECT 1; SELECT 2', 'SELECT 1; -- comment\n DELETE FROM world_sql']) {
    const result = await sql(query)
    expect(result.isError, query).toBe(true)
  }
  expect(text(await sql('SELECT value FROM world_sql'))).toBe('value\noriginal')
  const db = new DatabaseSync(database, { readOnly: true })
  expect(db.prepare('SELECT value FROM world_sql').all()).toEqual([{ value: 'original' }])
  db.close()
})

test('SQL validates row limits and reports complete-row truncation within output cap', async () => {
  for (const limit of [0, 1001, 1.5]) expect((await sql('SELECT 1', limit)).isError).toBe(true)
  expect(text(await sql('SELECT 1 AS n UNION ALL SELECT 2', 1))).toBe('n\n1\n[truncated: row limit]')
  const result = text(await sql("SELECT printf('%.*c', 31990, 'x') AS value UNION ALL SELECT 'second'"))
  expect(result.length).toBeLessThanOrEqual(32000)
  expect(result).toContain('[truncated: output limit]')
  expect(result).not.toContain('second')
  expect(text(await sql("SELECT printf('%.*c', 33000, 'x') AS value"))).toBe('value\n[truncated: output limit]')
  const full = text(await sql('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) SELECT x FROM n', 1000))
  expect(full.endsWith('999\n1000\n[truncated: row limit]')).toBe(true)
})

test('SQL times out without blocking stdio and recovers', async () => {
  const started = Date.now()
  const pending = sql('WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n')
  const discovery = await client.listTools()
  expect(Date.now() - started).toBeLessThan(3000)
  expect(discovery.tools.some((tool) => tool.name === 'sql')).toBe(true)
  expect(text(await sql('SELECT 7 AS concurrent'))).toBe('concurrent\n7')
  const result = await pending
  expect(result.isError).toBe(true)
  expect(text(result)).toMatch(/timed out/i)
  expect(text(await sql('SELECT 42 AS answer'))).toBe('answer\n42')
}, 15000)
