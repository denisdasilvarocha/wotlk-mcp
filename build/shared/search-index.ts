import type { Database } from '../../src/database.ts'

// record_fts projects each Record's name and search text; index Records not yet projected.
export function indexRecords(db: Database): void {
  db.exec(
    'INSERT INTO record_fts SELECT id, name, search_text FROM record WHERE id NOT IN (SELECT id FROM record_fts)'
  )
}
