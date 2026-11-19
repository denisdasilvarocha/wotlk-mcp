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

test('distinguishes positive and negative infinity in DBC hashes', () => {
  using positive = new DatabaseSync(':memory:')
  using negative = new DatabaseSync(':memory:')

  importFloat(positive, Infinity)
  importFloat(negative, -Infinity)

  expect(
    positive.prepare("SELECT value FROM meta WHERE key = 'hash.dbc_Item'").get()?.value
  ).not.toBe(negative.prepare("SELECT value FROM meta WHERE key = 'hash.dbc_Item'").get()?.value)
})

function importString(db: DatabaseSync, bytes: Buffer): void {
  db.exec(`
    CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE dbc_foreign_key (source_table TEXT, field TEXT, target_table TEXT, target_field TEXT);
    CREATE TABLE record (id TEXT, kind TEXT, name TEXT, source_table TEXT, source_row INTEGER, search TEXT, hint TEXT);
  `)
  const data = Buffer.alloc(25 + bytes.length)
  data.write('WDBC')
  data.writeUInt32LE(1, 4)
  data.writeUInt32LE(1, 8)
  data.writeUInt32LE(4, 12)
  data.writeUInt32LE(bytes.length + 1, 16)
  data.writeUInt32LE(1, 20)
  bytes.copy(data, 25)

  importTable(
    db,
    data,
    [{ name: 'Name', size: 4, type: 'string', unsigned: false }],
    'Item',
    'DBFilesClient/Item.dbc',
    undefined,
    {
      foreign: db.prepare('INSERT INTO dbc_foreign_key VALUES (?, ?, ?, ?)'),
      record: db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')
    }
  )
}

test.each([Buffer.from([0xc0, 0xaf, 0]), Buffer.from([0xe2, 0x82, 0])])(
  'rejects malformed UTF-8 with field and string-block offset',
  (bytes) => {
    using db = new DatabaseSync(':memory:')

    expect(() => importString(db, bytes)).toThrow(
      'Invalid UTF-8 in dbc_Item.Name at string-block offset 1'
    )
    expect(db.prepare('SELECT Name FROM dbc_Item').all()).toEqual([])
    expect(db.prepare('SELECT key FROM meta').all()).toEqual([])
  }
)

test.each([
  ['\uFEFFname', Buffer.from([0xef, 0xbb, 0xbf, 0x6e, 0x61, 0x6d, 0x65, 0])],
  ['\uFFFD', Buffer.from([0xef, 0xbf, 0xbd, 0])]
])('preserves valid UTF-8 text %s', (expected, bytes) => {
  using db = new DatabaseSync(':memory:')

  importString(db, bytes)

  expect(db.prepare('SELECT Name FROM dbc_Item').get()?.Name).toBe(expected)
})

function hashRows(field: string, values: readonly number[]): unknown {
  using db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE meta (key TEXT, value TEXT);
    CREATE TABLE dbc_foreign_key (source_table TEXT, field TEXT, target_table TEXT, target_field TEXT);
    CREATE TABLE record (id TEXT, kind TEXT, name TEXT, source_table TEXT, source_row INTEGER, search TEXT, hint TEXT);
  `)
  const data = Buffer.alloc(21 + values.length * 4)
  data.write('WDBC')
  data.writeUInt32LE(values.length, 4)
  data.writeUInt32LE(1, 8)
  data.writeUInt32LE(4, 12)
  data.writeUInt32LE(1, 16)
  values.forEach((value, index) => data.writeFloatLE(value, 20 + index * 4))

  importTable(
    db,
    data,
    [{ name: field, size: 4, type: 'float', unsigned: false }],
    'Item',
    'DBFilesClient/Item.dbc',
    undefined,
    {
      foreign: db.prepare('INSERT INTO dbc_foreign_key VALUES (?, ?, ?, ?)'),
      record: db.prepare('INSERT INTO record VALUES (?, ?, ?, ?, ?, ?, ?)')
    }
  )

  return db.prepare("SELECT value FROM meta WHERE key = 'hash.dbc_Item'").get()?.value
}

test('DBC hashes include field schema', () => {
  const speed = hashRows('Speed', [1])
  const rate = hashRows('Rate', [1])

  expect(speed).not.toBe(rate)
})

test('DBC hashes include row order', () => {
  const forward = hashRows('Speed', [1, 2])
  const reverse = hashRows('Speed', [2, 1])

  expect(forward).not.toBe(reverse)
})
