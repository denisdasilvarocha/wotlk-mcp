import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, expect, test } from 'vite-plus/test'

const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-fts-'))
const database = path.join(directory, 'reference.sqlite')
const client = new Client({ name: 'sql-fts-test', version: '1' })

beforeAll(async () => {
  initReference(database)
  const db = new DatabaseSync(database)

  try {
    db.exec(`
      INSERT INTO record_fts VALUES ('spell:133', 'Fireball', '');
      INSERT INTO record_fts VALUES ('spell:116', 'Frostbolt', '');
      INSERT INTO ui_line_fts VALUES ('FrameXML/Test.lua', 1, 'function CastFireball()');
    `)
  } finally {
    db.close()
  }

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

test.each([
  {
    expected: 'id\nspell:133',
    query: "SELECT id FROM record_fts WHERE record_fts MATCH 'Fireball'"
  },
  {
    expected: 'path\tline\nFrameXML/Test.lua\t1',
    query: "SELECT path, line FROM ui_line_fts WHERE ui_line_fts MATCH 'CastFireball'"
  }
])('SQL permits FTS5 reads: $query', async ({ expected, query }) => {
  const result = await sql(query)

  expect(result.isError).not.toBe(true)
  expect(result.content).toEqual([{ text: expected, type: 'text' }])
})

test.each([
  'PRAGMA data_version',
  'PRAGMA main.data_version',
  'SELECT * FROM pragma_data_version',
  'SELECT count(*) FROM PrAgMa_DaTa_VeRsIoN()',
  "SELECT id FROM record_fts, pragma_data_version WHERE record_fts MATCH 'Fireball'"
])('SQL does not expose data_version: %s', async (query) => {
  const result = await sql(query)

  expect(result.isError).toBe(true)
})
