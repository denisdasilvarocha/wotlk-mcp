import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { importInterface } from './interface.ts'

const [, , database, directory, manifestHash] = process.argv
if (!database || !directory || !manifestHash || process.argv.length !== 5)
  throw new Error(
    'Usage: vp run import:interface <existing-database> <client-inputs-directory> <trusted-manifest-sha256>'
  )
if (!existsSync(database)) throw new Error(`Database does not exist: ${database}`)
const db = new DatabaseSync(database, { open: false })
db.open()
db.exec('BEGIN')
try {
  importInterface(db, directory, manifestHash)
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
} finally {
  db.close()
}
