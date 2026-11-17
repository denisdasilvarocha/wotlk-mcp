import { DatabaseSync } from 'node:sqlite'

import { clientExecutableSha256 } from '../shared/client-manifest.ts'
import { isRecord } from '../shared/record.ts'
import { sha256Hex } from '../shared/sha256.ts'
import { readNativeInput } from './input.ts'
import { insertRegistrations } from './insert.ts'
import { resolveWidgets } from './resolution.ts'

export function importNative(
  database: string,
  directory: string,
  manifestHash: string,
  overridePath?: string
): void {
  const { decisionHash, dumpText, missingWidgets, overrides, rows } = readNativeInput(
    directory,
    manifestHash,
    overridePath
  )

  const db = new DatabaseSync(database)

  db.exec('PRAGMA foreign_keys = ON; BEGIN')

  try {
    const resolution = resolveWidgets(db, rows, missingWidgets, overrides)
    insertRegistrations(db, rows, overrides, resolution)

    db.prepare('INSERT INTO source VALUES (?, ?, ?, ?, ?)').run(
      'native-registrations',
      clientExecutableSha256,
      sha256Hex(dumpText),
      'Client-derived; redistribution risk accepted, permission not established',
      'Fingerprint-verified client executable registration tables; enGB English stand-in'
    )

    const pins: unknown = JSON.parse(
      String(db.prepare("SELECT value FROM meta WHERE key = 'input_pins'").get()?.value)
    )
    if (!isRecord(pins)) {
      throw new Error('Invalid input pins')
    }

    pins.native = sha256Hex(dumpText)
    pins.native_manifest = manifestHash

    if (decisionHash) {
      pins.native_widget_decisions = decisionHash
    }
    db.prepare("UPDATE meta SET value = ? WHERE key = 'input_pins'").run(JSON.stringify(pins))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.close()
  }
}
