import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { expect, test } from 'vite-plus/test'

import { canonicalTableHash } from '../scripts/canonical-table-hash.ts'
import { kinds, relations } from '../src/schema.ts'

test('preparation versions, validates and measures the final compressed reference', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prepare-reference-'))
  try {
    const database = path.join(dir, 'wotlk.sqlite')
    const asset = `${database}.br`
    const db = new DatabaseSync(database)
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
    const entityInsert = db.prepare('INSERT INTO entity VALUES (?,?)')
    const record = db.prepare('INSERT INTO record VALUES (?,?,?,?,?,?,?)')
    const index = db.prepare('INSERT INTO record_fts VALUES (?,?,?)')
    for (const [i, kind] of kinds.entries()) {
      const id = `${kind}:1`
      const result = entityInsert.run(i + 1, kind)
      record.run(id, kind, kind, 'entity', result.lastInsertRowid, '', '')
      index.run(id, kind, '')
    }
    db.exec(
      "INSERT INTO offsets_entry VALUES ('one','0x00400000'); UPDATE record SET source_table='offsets_entry',source_row=1 WHERE id='offset:1'; INSERT INTO lua_native_registration VALUES ('fn:1','0x00400000'); INSERT INTO ui_line VALUES('test.lua',1,'hello'); INSERT INTO ui_line_fts VALUES('test.lua',1,'hello');"
    )
    const link = db.prepare('INSERT INTO link VALUES (?,?,?,?)')
    for (const [relation] of relations) {
      let target = 'item:1'
      if (relation === 'implemented by') target = 'offset:1'
      link.run('fn:1', relation, target, '')
    }
    const tables = db
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' AND name<>'meta'"
      )
      .all()
    const insert = db.prepare('INSERT INTO meta VALUES (?,?)')
    for (const row of tables) {
      const name = String(row.name)
      const { hash, count } = canonicalTableHash(db, name)
      insert.run(`canonical_hash.${name}`, hash)
      insert.run(`canonical_count.${name}`, count)
    }
    db.close()
    writeFileSync(asset, brotliCompressSync(readFileSync(database)))
    writeFileSync(
      path.join(dir, 'build-report.json'),
      JSON.stringify({ build_seconds: 1, timings_seconds: { compression: 0.1 } })
    )
    const versions = path.join(dir, 'versions.json')
    writeFileSync(versions, JSON.stringify(['1.0.0']))
    const result = spawnSync(
      process.execPath,
      ['scripts/prepare-reference.ts', dir, `--used-versions=${versions}`],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(0)
    const final = readFileSync(database)
    const compressed = readFileSync(asset)
    expect(brotliDecompressSync(compressed)).toEqual(final)
    const verified = new DatabaseSync(database, { readOnly: true })
    expect(verified.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe(
      '1.0.1'
    )
    verified.close()
    const report = JSON.parse(readFileSync(path.join(dir, 'build-report.json'), 'utf8'))
    const gate = JSON.parse(readFileSync(path.join(dir, 'gate.json'), 'utf8'))
    expect(gate.version).toBe('1.0.1')
    expect(report.uncompressed_bytes).toBe(statSync(database).size)
    expect(report.compressed_bytes).toBe(compressed.length)
    expect(report.compressed_sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
    expect(report.compressed_250_mb_gate_passed).toBe(true)
    expect(report.timings_seconds.compression).toBeGreaterThanOrEqual(0.1)
    expect(report.build_seconds).toBeGreaterThanOrEqual(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
