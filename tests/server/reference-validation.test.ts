import { cached } from '../../src/acquire/cache.ts'
import { getRecords, openReference } from '../../src/reference.ts'
import { schema } from '../../src/schema.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vite-plus/test'

function cacheDatabase(
  directory: string,
  version: string,
  observed: number,
  missing?: string
): void {
  const file = `db-v${version}-abc.sqlite`
  using db = new DatabaseSync(path.join(directory, file))
  db.exec(schema)
  db.prepare("INSERT INTO meta VALUES ('schema_version', ?)").run(version)
  if (missing) {
    db.exec(`ALTER TABLE record DROP COLUMN ${missing}`)
  }
  writeFileSync(
    path.join(directory, `state-${observed}-abc.json`),
    JSON.stringify({ file, lastCheck: observed, version: `db-v${version}` })
  )
}

test.each(['search_text', 'hint'])(
  'a cached database without record.%s cannot displace a usable fallback',
  async (column) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'reference-validation-'))

    try {
      const now = Date.now()
      cacheDatabase(directory, '1.0.0', now - 1)
      cacheDatabase(directory, '1.1.0', now, column)

      const selected = await cached(directory)

      expect(selected?.state.version).toBe('db-v1.0.0')
    } finally {
      rmSync(directory, { force: true, recursive: true })
    }
  }
)

test.each([
  ['missing ui_file', 'DROP TABLE ui_file'],
  ['missing ui_file.path', 'DROP TABLE ui_file; CREATE TABLE ui_file (other TEXT)'],
  ['missing ui_line', 'DROP TABLE ui_line'],
  ['missing ui_line.path', 'ALTER TABLE ui_line DROP COLUMN path'],
  ['missing ui_line.line', 'ALTER TABLE ui_line DROP COLUMN line'],
  ['missing ui_line.text', 'ALTER TABLE ui_line DROP COLUMN text']
])('a cached database with %s falls back to a usable file snapshot', async (_name, change) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'reference-validation-'))

  try {
    const now = Date.now()
    cacheDatabase(directory, '1.0.0', now - 1)
    cacheDatabase(directory, '1.1.0', now)

    for (const version of ['1.0.0', '1.1.0']) {
      using db = new DatabaseSync(path.join(directory, `db-v${version}-abc.sqlite`))
      db.exec(`
        CREATE TABLE ui_file (path TEXT);
        CREATE TABLE ui_line (path TEXT, line INTEGER, text TEXT);
        INSERT INTO ui_file VALUES ('Example.lua');
        INSERT INTO ui_line VALUES ('Example.lua', 1, 'hello');
        INSERT INTO record VALUES ('file:Example.lua', 'file', 'Example.lua', 'ui_file', 1, '', '');
      `)
      if (version === '1.1.0') {
        db.exec(change)
      }
    }

    const selected = await cached(directory)

    expect(selected?.state.version).toBe('db-v1.0.0')
    using db = openReference(selected!.path)
    expect(getRecords(db, ['file:Example.lua'])).toContain('1: hello')
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
