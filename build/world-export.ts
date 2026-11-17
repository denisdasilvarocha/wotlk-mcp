import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import type { SourceArchive } from './sources.ts'
import { hashRow } from './world-data.ts'
import { populateWorldMetadata } from './world-metadata.ts'
import { createWorldScanner } from './world-scan.ts'
import { readWorldSchema, verifyWorldSchema } from './world-schema.ts'
import { exportTable } from './world-table.ts'

function mysqlArguments(container: string): string[] {
  return [
    'exec',
    '-e',
    'MYSQL_PWD=local-proof-only',
    container,
    'mysql',
    '-uroot',
    '--default-character-set=utf8mb4',
    '--batch',
    '--raw',
    '--skip-column-names',
    '--quick',
    'acore_world',
    '-e'
  ]
}

export async function exportWorld(
  container: string,
  output: string,
  source: Readonly<SourceArchive>,
  importerImage: string,
  work: string,
  signal: Readonly<AbortSignal>,
  mysqlImage: string,
  runDocker: (
    args: readonly string[],
    signal: Readonly<AbortSignal>
  ) => Promise<{ stdout: string; stderr: string }>
): Promise<void> {
  if (!existsSync(output)) {
    throw new Error('Reference database does not exist')
  }
  const mysqlArgs = mysqlArguments(container)
  async function mysql(query: string): Promise<string> {
    const result = await runDocker([...mysqlArgs, query], signal)
    return result.stdout
  }
  await verifyWorldSchema(mysql, work)
  const tables = readWorldSchema()
  const scan = createWorldScanner(mysqlArgs, signal)
  const db = new DatabaseSync(output)
  db.exec('BEGIN IMMEDIATE')
  try {
    const metadata = db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
    for (const [table, columns] of tables) {
      // eslint-disable-next-line no-await-in-loop -- Tables are exported in source order within one transaction.
      await exportTable({ db, hashRow, metadata, mysql, scan }, table, columns)
    }
    populateWorldMetadata(db, metadata, source, mysqlImage, importerImage)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
