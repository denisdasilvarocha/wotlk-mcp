import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync } from 'node:zlib'

import { expect, test } from 'vite-plus/test'

import { canonicalTableHash } from '../scripts/canonical-table-hash.ts'

const kinds = [
  'spell',
  'talent',
  'itemset',
  'skillline',
  'map',
  'area',
  'faction',
  'class',
  'race',
  'achievement',
  'creature',
  'item',
  'quest',
  'gameobject',
  'fn',
  'event',
  'widget',
  'method',
  'cvar',
  'type',
  'cle',
  'template',
  'slash',
  'offset',
  'file'
]
const relations = [
  'drops',
  'starts',
  'ends',
  'rewards',
  'sells',
  'teaches',
  'casts',
  'contains',
  'grants',
  'belongs to',
  'faction',
  'spawns in',
  'implemented by'
]
function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-gate-'))
  const file = path.join(dir, 'candidate.sqlite')
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO meta VALUES('schema_version','1.0.0'),('input_pins','{"fixture":"one"}');
    CREATE TABLE source(name TEXT PRIMARY KEY,pin TEXT,sha256 TEXT,licence TEXT,attribution TEXT);
    INSERT INTO source VALUES('fixture','one','abc','test','test');
    CREATE TABLE record(id TEXT,kind TEXT,name TEXT,source_table TEXT,source_row INTEGER,search_text TEXT,hint TEXT);
    CREATE TABLE link(source_id TEXT,relation TEXT,destination_id TEXT,notes TEXT);
    CREATE TABLE entity(ID INTEGER,name TEXT); CREATE TABLE offsets_entry(path TEXT,va TEXT);
    CREATE TABLE lua_native_registration(record_id TEXT,va TEXT);
    CREATE TABLE ui_line(path TEXT,line INTEGER,text TEXT);
    CREATE VIRTUAL TABLE record_fts USING fts5(id UNINDEXED,name,text,tokenize='trigram');
    CREATE VIRTUAL TABLE ui_line_fts USING fts5(path UNINDEXED,line UNINDEXED,text,tokenize='trigram');`)
  const row = db.prepare('INSERT INTO entity VALUES (?, ?)')
  const record = db.prepare('INSERT INTO record VALUES (?,?,?,?,?,?,?)')
  const index = db.prepare('INSERT INTO record_fts VALUES (?,?,?)')
  for (const kind of kinds) {
    const id = `${kind}:1`
    const result = row.run(kinds.indexOf(kind) + 1, kind)
    record.run(id, kind, kind, 'entity', result.lastInsertRowid, '', '')
    index.run(id, kind, '')
  }
  db.exec(
    "INSERT INTO offsets_entry VALUES ('one','0x00400000'); UPDATE record SET source_table='offsets_entry',source_row=1 WHERE id='offset:1'; INSERT INTO lua_native_registration VALUES ('fn:1','0x00400000'); INSERT INTO ui_line VALUES('test.lua',1,'hello'); INSERT INTO ui_line_fts VALUES('test.lua',1,'hello');"
  )
  const link = db.prepare('INSERT INTO link VALUES (?,?,?,?)')
  for (const rel of relations) {
    let target = 'item:1'
    if (rel === 'implemented by') target = 'offset:1'
    link.run('fn:1', rel, target, '')
  }
  db.close()
  seal(file)
  return file
}
function seal(file: string): void {
  const db = new DatabaseSync(file)
  db.exec("DELETE FROM meta WHERE key LIKE 'canonical_hash.%' OR key LIKE 'canonical_count.%'")
  const names = db
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name<>'meta'"
    )
    .all()
  const insert = db.prepare('INSERT INTO meta VALUES (?,?)')
  for (const row of names) {
    const name = String(row.name)
    const { hash, count } = canonicalTableHash(db, name)
    insert.run(`canonical_hash.${name}`, hash)
    insert.run(`canonical_count.${name}`, count)
  }
  db.close()
}
function gate(file: string, ...args: string[]): SpawnSyncReturns<string> {
  seal(file)
  writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file)))
  return spawnSync('vpx', ['scripts/release-gate.ts', file, `${file}.br`, ...args], {
    encoding: 'utf8'
  })
}
test('first release checks a real complete artifact and emits version 1.0.0', () => {
  const file = fixture()
  const result = gate(file)
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).version).toBe('1.0.0')
})
test.each([
  ['missing source', "UPDATE record SET source_row=999 WHERE id='spell:1'"],
  ['missing link endpoint', "UPDATE link SET destination_id='item:missing' WHERE relation='drops'"],
  ['kind coverage', "DELETE FROM record WHERE kind='spell'"],
  ['relation coverage', "DELETE FROM link WHERE relation='drops'"],
  ['native evidence', "UPDATE lua_native_registration SET va='0x00400001'"],
  ['Interface FTS coverage', 'DELETE FROM ui_line_fts'],
  ['duplicate IDs', "INSERT INTO record SELECT * FROM record WHERE id='spell:1'"],
  [
    'corrupt FTS index',
    "UPDATE record_fts_data SET block=X'00' WHERE id=(SELECT max(id) FROM record_fts_data)"
  ],
  ['FTS coverage', "DELETE FROM record_fts WHERE id='spell:1'"]
])('rejects %s', (_name, sql) => {
  const file = fixture()
  const db = new DatabaseSync(file)
  db.enableDefensive?.(false)
  db.exec(sql)
  db.close()
  const result = gate(file)
  expect(result.status).not.toBe(0)
})

test('compares previous versions, shrink, drift and explicit override', () => {
  const candidate = fixture()
  const previous = `${candidate}.previous`
  copyFileSync(candidate, previous)
  let db = new DatabaseSync(candidate)
  db.exec('UPDATE meta SET value=\'{"fixture":"two"}\' WHERE key=\'input_pins\'')
  db.close()
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(JSON.parse(gate(candidate, previous).stdout).version).toBe('1.0.1')
  db = new DatabaseSync(candidate)
  db.exec('ALTER TABLE entity ADD COLUMN extra TEXT')
  db.close()
  expect(gate(candidate, previous).status).not.toBe(0)
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(JSON.parse(gate(candidate, previous).stdout).version).toBe('1.1.0')
  db = new DatabaseSync(previous)
  db.exec('CREATE TABLE removed_table(value TEXT)')
  db.close()
  expect(gate(candidate, previous, '--allow-shrink', '--prepare').status).toBe(0)
  expect(JSON.parse(gate(candidate, previous, '--allow-shrink').stdout).version).toBe('2.0.0')
  db = new DatabaseSync(previous)
  db.exec('DROP TABLE removed_table; INSERT INTO entity SELECT ID + 100, name FROM entity')
  db.close()
  expect(gate(candidate, previous, '--prepare').status).not.toBe(0)
  expect(gate(candidate, previous, '--allow-shrink', '--prepare').status).toBe(0)
  expect(gate(candidate, previous, '--allow-shrink').status).toBe(0)
  db = new DatabaseSync(candidate)
  db.exec('UPDATE meta SET value=\'{"fixture":"one"}\' WHERE key=\'input_pins\'')
  db.close()
  expect(gate(candidate, previous, '--allow-shrink', '--prepare').status).not.toBe(0)
})

test('rejects an oversized or mismatched compressed asset', () => {
  const file = fixture()
  const asset = `${file}.br`
  writeFileSync(asset, Buffer.alloc(0))
  truncateSync(asset, 250_000_001)
  const result = spawnSync('vpx', ['scripts/release-gate.ts', file, asset], { encoding: 'utf8' })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('250 MB')
  writeFileSync(asset, brotliCompressSync(Buffer.from('wrong')))
  expect(spawnSync('vpx', ['scripts/release-gate.ts', file, asset]).status).not.toBe(0)
})

test('changed IDs for the same source Record require a major version', () => {
  const candidate = fixture()
  const previous = `${candidate}.previous`
  copyFileSync(candidate, previous)
  const db = new DatabaseSync(candidate)
  db.exec(
    "UPDATE meta SET value='{\"fixture\":\"two\"}' WHERE key='input_pins'; UPDATE record SET id='spell:renamed' WHERE id='spell:1'; UPDATE record_fts SET id='spell:renamed' WHERE id='spell:1'"
  )
  db.close()
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(JSON.parse(gate(candidate, previous).stdout).version).toBe('2.0.0')
})
test('duplicate names and reordered physical rows do not change stable source identity', () => {
  const candidate = fixture()
  const db = new DatabaseSync(candidate)
  db.exec(
    "INSERT INTO entity VALUES (100,'duplicate'); UPDATE entity SET name='duplicate' WHERE ID=1; UPDATE record SET name='duplicate' WHERE id='spell:1'; UPDATE record_fts SET name='duplicate' WHERE id='spell:1'; INSERT INTO record VALUES ('spell:100','spell','duplicate','entity',26,'',''); INSERT INTO record_fts VALUES ('spell:100','duplicate','')"
  )
  db.close()
  const previous = `${candidate}.previous`
  seal(candidate)
  copyFileSync(candidate, previous)
  const changed = new DatabaseSync(candidate)
  changed.exec(
    "UPDATE meta SET value='{\"fixture\":\"two\"}' WHERE key='input_pins'; UPDATE entity SET rowid=200 WHERE ID=1; UPDATE entity SET rowid=1 WHERE ID=100; UPDATE entity SET rowid=26 WHERE ID=1; UPDATE record SET source_row=CASE source_row WHEN 1 THEN 26 WHEN 26 THEN 1 ELSE source_row END WHERE kind='spell'"
  )
  changed.close()
  expect(gate(candidate, previous, '--prepare').status).toBe(0)
  expect(JSON.parse(gate(candidate, previous).stdout).version).toBe('1.0.1')
})

test('rejects invalid declared logical hashes', () => {
  const file = fixture()
  const db = new DatabaseSync(file)
  db.exec("UPDATE meta SET value='bad' WHERE key='canonical_hash.entity'")
  db.close()
  writeFileSync(`${file}.br`, brotliCompressSync(readFileSync(file)))
  expect(spawnSync('vpx', ['scripts/release-gate.ts', file, `${file}.br`]).status).not.toBe(0)
})

test.each(['kind', 'relation'])('rejects %s shrink independently of table counts', (dimension) => {
  const candidate = fixture()
  let db = new DatabaseSync(candidate)
  if (dimension === 'relation')
    for (let i = 0; i < 10; i++)
      db.prepare("INSERT INTO link VALUES ('event:1','starts','item:1',?)").run(String(i))
  db.close()
  seal(candidate)
  const previous = `${candidate}.previous`
  copyFileSync(candidate, previous)
  db = new DatabaseSync(previous)
  if (dimension === 'kind')
    db.exec(
      "INSERT INTO record SELECT 'spell:2',kind,name,source_table,source_row,search_text,hint FROM record WHERE id='spell:1'; INSERT INTO record_fts SELECT 'spell:2',name,text FROM record_fts WHERE id='spell:1'"
    )
  else db.exec("INSERT INTO link VALUES ('event:1','drops','item:1','')")
  db.close()
  db = new DatabaseSync(candidate)
  db.exec('UPDATE meta SET value=\'{"fixture":"two"}\' WHERE key=\'input_pins\'')
  db.close()
  const rejected = gate(candidate, previous, '--prepare')
  expect(rejected.status).not.toBe(0)
  let expected = 'relation:drops'
  if (dimension === 'kind') expected = 'kind:spell'
  expect(rejected.stderr).toContain(expected)
  expect(gate(candidate, previous, '--prepare', '--allow-shrink').status).toBe(0)
})
