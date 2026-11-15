import { DatabaseSync } from 'node:sqlite'

import { canonicalTableHash, canonicalTables } from '../build/table-hash.ts'
import { kinds, relations } from '../src/schema.ts'

export function createReleaseFixture(database: string): void {
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

  const row = db.prepare('INSERT INTO entity VALUES (?, ?)')
  const record = db.prepare('INSERT INTO record VALUES (?,?,?,?,?,?,?)')
  const index = db.prepare('INSERT INTO record_fts VALUES (?,?,?)')

  for (const [i, kind] of kinds.entries()) {
    const id = `${kind}:1`
    const result = row.run(i + 1, kind)

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

  db.close()
}

export function sealReleaseFixture(database: string): void {
  const db = new DatabaseSync(database)

  db.exec("DELETE FROM meta WHERE key LIKE 'canonical_hash.%' OR key LIKE 'canonical_count.%'")

  const insert = db.prepare('INSERT INTO meta VALUES (?,?)')

  for (const name of canonicalTables(db)) {
    const { hash, count } = canonicalTableHash(db, name)

    insert.run(`canonical_hash.${name}`, hash)
    insert.run(`canonical_count.${name}`, count)
  }

  db.close()
}
