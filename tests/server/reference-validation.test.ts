import { cached } from '../../src/acquire/cache.ts'
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
