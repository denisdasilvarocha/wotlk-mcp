import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-budget-'))
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'sql-budget-test', version: '1' })

beforeAll(async () => {
  initReference(database)
  unpackPackage(directory)
  await client.connect(packagedServer(directory, database))
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { force: true, recursive: true })
})

function sql(query: string): ReturnType<Client['callTool']> {
  return client.callTool({ arguments: { query }, name: 'sql' })
}

test('SQL rejects an oversized aggregate even when its result is small', async () => {
  const result = await sql(`
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<40)
    SELECT length(group_concat(printf('%.*c', 1048576, 'x'), '')) AS bytes FROM n
  `)

  expect(result.isError).toBe(true)
  expect(result.content).toEqual([
    { text: expect.stringMatching(/string or blob too big/iu), type: 'text' }
  ])
  expect((await sql('SELECT 42 AS answer')).content).toEqual([{ text: 'answer\n42', type: 'text' }])
})

test('SQL stops a worker whose total resident memory exceeds the process budget', async () => {
  const columns = Array.from({ length: 13 }, () => 'randomblob(16777216)').join(', ')
  const result = await sql(`
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000)
    SELECT ${columns}, (SELECT sum(x) FROM n)
  `)

  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ text: 'SQL worker exceeded its memory budget', type: 'text' }])
}, 10000)

test.each([
  {
    expected: '[truncated: output limit]',
    name: 'escaped header',
    query: `SELECT 1 AS "${'\t'.repeat(16001)}"`
  },
  {
    expected: 'prefix\tvalue\n[truncated: output limit]',
    name: 'escaped text after another field',
    query: "SELECT printf('%.*c', 20000, 'x') AS prefix, printf('%.*c', 6000, char(9)) AS value"
  },
  {
    expected: 'value\n[truncated: output limit]',
    name: 'hexadecimal blob',
    query: 'SELECT zeroblob(16000) AS value'
  }
])('SQL omits a whole line if it cannot fit a $name', async ({ expected, query }) => {
  const result = await sql(query)

  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ text: expected, type: 'text' }])
})
