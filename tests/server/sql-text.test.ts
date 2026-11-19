import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-text-'))
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'sql-text-test', version: '1' })

beforeAll(async () => {
  initReference(database)
  unpackPackage(directory)
  await client.connect(packagedServer(directory, database))
})

afterAll(async () => {
  await client.close()
  rmSync(directory, { force: true, recursive: true })
})

test('packed SQL preserves embedded NUL text without changing headers, types, or order', async () => {
  const query = `/* leading µ */ WITH _wotlk_text_rows_0(value, ordering) AS (
    VALUES (x'610062', 1), ('~00ff', 2), ('a' || char(0) || 'b', 3), (NULL, 4)
  )
  SELECT value AS same, char(0) || 'é' AS same, ordering AS position
  FROM _wotlk_text_rows_0 ORDER BY ordering DESC; -- trailing comment`

  const result = await client.callTool({ arguments: { query }, name: 'sql' })

  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([
    {
      text: 'same\tsame\tposition\nNULL\t\0é\t4\na\0b\t\0é\t3\n~00ff\t\0é\t2\n\\x610062\t\0é\t1',
      type: 'text'
    }
  ])
})

test('packed SQL preserves embedded NUL text before a final line comment without a newline', async () => {
  const query = "SELECT 'a' || char(0) || 'b' AS value -- final comment"

  const result = await client.callTool({ arguments: { query }, name: 'sql' })

  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ text: 'value\na\0b', type: 'text' }])
})

test('packed SQL keeps direct discovery pragmas usable after leading trivia', async () => {
  const query = "/* leading comment */ PRAGMA table_info('meta'); -- trailing comment"

  const result = await client.callTool({ arguments: { query }, name: 'sql' })

  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([
    { text: expect.stringMatching(/^cid\tname\ttype\tnotnull\tdflt_value\tpk\n/u), type: 'text' }
  ])
})
