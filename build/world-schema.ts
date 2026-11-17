import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Column, Kind } from './world-data.ts'

export async function verifyWorldSchema(
  mysql: (query: string) => Promise<string>,
  work: string
): Promise<void> {
  const environment = await mysql(
    'SELECT VERSION(),@@global.sql_mode,@@global.time_zone,@@global.character_set_server,@@global.collation_server'
  )
  const expectedEnvironment =
    '8.4.3\tONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION\t+00:00\tutf8mb4\tutf8mb4_general_ci\n'

  if (environment !== expectedEnvironment) {
    throw new Error('World MySQL environment does not match the pinned reproduction')
  }

  for (const part of ['columns', 'indexes']) {
    const expected = readFileSync(`data/world/schema-${part}.tsv`, 'utf8')
    // eslint-disable-next-line no-await-in-loop -- Schema checks run sequentially and stop on the first drift.
    const actual = await mysql(readFileSync(`data/world/${part}.sql`, 'utf8'))

    writeFileSync(path.join(work, `schema-${part}.tsv`), actual)

    if (actual !== expected) {
      throw new Error(`World schema ${part} drifted`)
    }
  }
}

function columnKind(type: string, table: string, name: string): Kind {
  if (/^(tinyint|smallint|mediumint|int|bigint)\b/u.test(type)) {
    return /^bigint.*unsigned/u.test(type) ? 'unsigned' : 'integer'
  }
  if (/^(float|double|real)\b/u.test(type)) {
    return 'real'
  }
  if (
    /^(decimal|numeric|date|datetime|timestamp|time|year|char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/u.test(
      type
    )
  ) {
    return 'text'
  }
  if (/^(binary|varbinary|tinyblob|blob|mediumblob|longblob|bit)\b/u.test(type)) {
    return 'blob'
  }
  throw new Error(`Unsupported MySQL type ${type} in ${table}.${name}`)
}

export function readWorldSchema(): Map<string, Column[]> {
  const tables = new Map<string, Column[]>()
  for (const line of readFileSync('data/world/schema-columns.tsv', 'utf8').trimEnd().split('\n')) {
    const [table, , name, type, , , , charset] = line.split('\t')
    const kind = columnKind(type, table, name)
    if (charset && charset !== 'utf8mb4') {
      throw new Error(`Unsupported character set ${charset} in ${table}.${name}`)
    }
    const columns = tables.get(table) ?? []
    columns.push({ kind, name, type })
    tables.set(table, columns)
  }
  return tables
}
