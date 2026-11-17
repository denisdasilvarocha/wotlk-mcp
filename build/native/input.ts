import { clientExecutableSha256, readClientManifest } from '../shared/client-manifest.ts'
import { isRecord } from '../shared/record.ts'
import { sha256Hex } from '../shared/sha256.ts'
import {
  isRegistration,
  parseDecisions,
  type Registration,
  type TableDecision,
  validateRegistrations
} from './registration.ts'
import { readFileSync } from 'node:fs'
import path from 'node:path'

type Decisions = Record<string, TableDecision | undefined>

function readDump(
  directory: string,
  manifestHash: string
): { dumpText: string; rows: Registration[] } {
  const files = readClientManifest(directory, manifestHash).filter(
    (file) => file.path === 'native-registrations.json'
  )
  const dumpText = readFileSync(path.join(directory, 'native-registrations.json'), 'utf8')
  if (files.length !== 1 || sha256Hex(dumpText) !== files[0].sha256) {
    throw new Error('Untrusted native extraction or SHA-256 mismatch')
  }
  const dump: unknown = JSON.parse(dumpText)
  if (
    !isRecord(dump) ||
    dump.format !== 1 ||
    dump.executable_sha256 !== clientExecutableSha256 ||
    !Array.isArray(dump.registrations)
  ) {
    throw new Error('Invalid native registration dump')
  }
  if (!dump.registrations.every(isRegistration)) {
    throw new Error('Invalid native registration row')
  }
  validateRegistrations(dump.registrations)
  return { dumpText, rows: dump.registrations }
}

function readDecisions(overridePath?: string): {
  decisionHash: string
  missingWidgets: Decisions
  overrides: Decisions
} {
  if (overridePath === undefined || overridePath === '') {
    return { decisionHash: '', missingWidgets: {}, overrides: {} }
  }
  const decisionText = readFileSync(overridePath, 'utf8')
  const parsed: unknown = JSON.parse(decisionText)
  if (!isRecord(parsed)) {
    throw new Error('Invalid widget decisions')
  }
  return {
    decisionHash: sha256Hex(decisionText),
    missingWidgets: parseDecisions(parsed.missing_widgets),
    overrides: parseDecisions(parsed.overrides)
  }
}

export function readNativeInput(
  directory: string,
  manifestHash: string,
  overridePath?: string
): {
  dumpText: string
  rows: Registration[]
  decisionHash: string
  missingWidgets: Decisions
  overrides: Decisions
} {
  const dump = readDump(directory, manifestHash)
  const decisions = readDecisions(overridePath)
  return { ...dump, ...decisions }
}
