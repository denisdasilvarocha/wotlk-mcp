import { initReference } from '../../build/offsets.ts'
import { packagedServer, unpackPackage } from '../helpers/package.ts'
import { Client } from '@modelcontextprotocol/client'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

test('SQL rejects an incompatible override replaced after the session starts', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'wotlk-sql-validation-'))
  const database = path.join(directory, 'reference.sqlite')
  const replacement = path.join(directory, 'replacement.sqlite')
  const client = new Client({ name: 'sql-validation-test', version: '1' })
  const sql = () => client.callTool({ arguments: { query: 'SELECT 1 AS n' }, name: 'sql' })

  try {
    initReference(database)
    initReference(replacement)
    const db = new DatabaseSync(replacement)
    db.exec("UPDATE meta SET value = '2.0.0' WHERE key = 'schema_version'")
    db.close()
    unpackPackage(directory)
    await client.connect(packagedServer(directory, database))
    expect((await sql()).content).toEqual([{ text: 'n\n1', type: 'text' }])
    renameSync(replacement, database)

    const result = await sql()

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      { text: expect.stringContaining('incompatible schema version 2.0.0'), type: 'text' }
    ])
  } finally {
    await client.close()
    rmSync(directory, { force: true, recursive: true })
  }
})
