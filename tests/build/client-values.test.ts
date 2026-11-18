import { importTable } from '../../build/client/table.js'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

function importFloat(db: DatabaseSync, value: number): void {
  db.exec(`
    CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE dbc_foreign_key (source_table TEXT, field TEXT, target_table TEXT, target_field TEXT);
    CREATE TABLE record (id TEXT, kind TEXT, name TEXT, source_table TEXT, source_row INTEGER, search TEXT, hint TEXT);
  `)
  const data = Buffer.alloc(25)
  data.write('WDBC')
  data.writeUInt32LE(1, 4)
  data.writeUInt32LE(1, 8)
  data.writeUInt32LE(4, 12)
  data.writeUInt32LE(1, 16)
  data.writeFloatLE(value, 20)

  importTable(
    db,
    data,
    [{ name: 'Speed', size: 4, type: 'float', unsigned: false }],
    'Item',
    'DBFilesClient/Item.dbc',
    undefined,
    {
      foreign: db.prepare('INSERT INTO dbc_foreign_key VALUES (?, ?, ?, ?)'),
      record: db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')
    }
  )
}

test.each([
  [-0, '-0'],
  [NaN, 'NaN']
] as const)('rejects DBC floats that would lose fidelity (%s)', (value, label) => {
  using db = new DatabaseSync(':memory:')

  expect(() => importFloat(db, value)).toThrow(
    `DBC floating conversion loss in dbc_Item.Speed: ${label}`
  )
  expect(db.prepare('SELECT Speed FROM dbc_Item').all()).toEqual([])
  expect(db.prepare('SELECT key FROM meta').all()).toEqual([])
})

test.each([0, -1.25, Infinity, -Infinity])('preserves the exact DBC float %s', (value) => {
  using db = new DatabaseSync(':memory:')

  importFloat(db, value)

  expect(db.prepare('SELECT Speed FROM dbc_Item').get()?.Speed).toBe(value)
})
