import { createHash } from 'node:crypto'
import type { StatementSync } from 'node:sqlite'

import type { Database } from '../src/database.ts'
import type { Field } from './client-layout.ts'
import { readValue } from './client-values.ts'
import type { DbcBuffer } from './client-values.ts'
import { quoteIdentifier } from './table-hash.ts'

type Statements = Readonly<{
  foreign: Readonly<Pick<StatementSync, 'run'>>
  record: Readonly<Pick<StatementSync, 'run'>>
  fts: Readonly<Pick<StatementSync, 'run'>>
}>
type Header = Readonly<{ rows: number; strings: number; width: number }>

function readHeader(
  data: DbcBuffer,
  fields: readonly Field[],
  name: string,
  entryPath: string
): Header {
  if (data.toString('ascii', 0, 4) !== 'WDBC') {
    throw new Error(`Invalid DBC: ${entryPath}`)
  }
  const rows = data.readUInt32LE(4),
    slots = data.readUInt32LE(8),
    strings = data.readUInt32LE(16),
    width = data.readUInt32LE(12)
  const expected = fields.reduce((n, field) => n + 1 + Number(Boolean(field.localized)) * 16, 0)
  const expectedWidth = fields.reduce(
    (n, field) => (field.localized === true ? n + 68 : n + field.size),
    0
  )
  if (
    slots !== expected ||
    width !== expectedWidth ||
    data.length !== 20 + rows * width + strings
  ) {
    throw new Error(
      `DBC schema mismatch: ${name} (${slots} != ${expected}, width ${width} != ${expectedWidth})`
    )
  }
  return { rows, strings, width }
}

function expandFields(fields: readonly Field[]): Field[] {
  return fields.flatMap((f) => {
    if (f.localized !== true) {
      return [f]
    }
    return [
      f,
      ...Array.from({ length: 16 }, (_, i) => ({
        ...f,
        localized: false,
        name: `${f.name}_${i + 1}`,
        target: undefined,
        type: i === 15 ? 'int' : 'string'
      }))
    ]
  })
}

function createTable(
  db: Database,
  fields: readonly Field[],
  expanded: readonly Field[],
  table: string,
  foreign: Readonly<Pick<StatementSync, 'run'>>
): Readonly<Pick<StatementSync, 'run'>> {
  const definitionsSql = expanded
    .map((f) => {
      let type = 'INTEGER'
      if (f.type === 'float') {
        type = 'REAL'
      }
      if (f.type.includes('string')) {
        type = 'TEXT'
      }
      return `${quoteIdentifier(f.name)} ${type}`
    })
    .join(', ')
  db.exec(`CREATE TABLE ${quoteIdentifier(table)} (${definitionsSql})`)
  for (const f of fields) {
    if (f.target !== undefined && f.target !== '') {
      const [target, key] = f.target.split('::')
      foreign.run(table, f.name, `dbc_${target}`, key ?? 'ID')
    }
  }
  return db.prepare(
    `INSERT INTO ${quoteIdentifier(table)} VALUES (${expanded.map(() => '?').join(',')})`
  )
}

function insertRecord(
  statements: Statements,
  fields: readonly Field[],
  values: readonly (number | string)[],
  kind: string,
  table: string,
  rowId: number | bigint
): void {
  const obj = Object.fromEntries(fields.map((f, i) => [f.name, values[i]]))
  const id = `${kind}:${obj.ID}`
  const label = String(
    obj.Name_lang ??
      obj.MapName_lang ??
      obj.AreaName_lang ??
      obj.DisplayName_lang ??
      obj.Title_lang ??
      obj.Name ??
      obj.ID
  )
  const description = String(obj.Description_lang ?? '')
  const hint = String(obj.NameSubtext_lang ?? '')
  statements.record.run(id, kind, label, table, rowId, description, hint)
  statements.fts.run(id, label, description)
}

function insertRows(
  db: Database,
  data: DbcBuffer,
  fields: readonly Field[],
  header: Header,
  statements: Statements,
  table: string,
  name: string,
  kind: string | undefined,
  insert: Readonly<Pick<StatementSync, 'run'>>
): void {
  const logicalHash = createHash('sha256')
    .update(JSON.stringify(fields.map((field) => [field.name, field.type])))
    .update('\n')
  const stringStart = 20 + header.rows * header.width
  for (let row = 0; row < header.rows; row++) {
    let cursor = 20 + row * header.width
    const values: (number | string)[] = []
    for (const field of fields) {
      values.push(readValue(data, field, cursor, header.strings, stringStart, name))
      cursor += field.size
    }
    logicalHash.update(JSON.stringify(values)).update('\n')
    const inserted = insert.run(...values)
    if (kind !== undefined && kind !== '') {
      insertRecord(statements, fields, values, kind, table, inserted.lastInsertRowid)
    }
  }
  db.prepare('INSERT INTO meta VALUES (?, ?)').run(`hash.${table}`, logicalHash.digest('hex'))
}

export function importTable(
  db: Database,
  data: DbcBuffer,
  fields: readonly Field[],
  name: string,
  entryPath: string,
  kind: string | undefined,
  statements: Statements
): void {
  const header = readHeader(data, fields, name, entryPath)
  const expanded = expandFields(fields)
  const table = `dbc_${name}`
  const insert = createTable(db, fields, expanded, table, statements.foreign)
  insertRows(db, data, expanded, header, statements, table, name, kind, insert)
}
