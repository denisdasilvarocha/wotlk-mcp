import type { DatabaseSync } from 'node:sqlite'

/** Read-only view of the `DatabaseSync` surface that query helpers use. */
export type Database = Readonly<Pick<DatabaseSync, 'close' | 'exec' | 'prepare'>>
