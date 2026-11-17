import { readFileSync } from 'node:fs'
import path from 'node:path'

import { isRecord } from '../shared/record.ts'
import {
  isRegistration,
  parseDecisions,
  type Registration,
  type TableDecision,
  validateRegistrations
} from './registration.ts'
import { sha } from './widget.ts'

export const expectedExecutable = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'

type Decisions = Record<string, TableDecision | undefined>

function readDump(
  directory: string,
  manifestHash: string
): { dumpText: string; rows: Registration[] } {
  const manifestText = readFileSync(path.join(directory, 'manifest.json'), 'utf8')
  if (!/^[a-f0-9]{64}$/u.test(manifestHash) || sha(manifestText) !== manifestHash) {
    throw new Error('Client manifest SHA-256 mismatch')
  }
  const manifest: unknown = JSON.parse(manifestText)
  if (!isRecord(manifest) || !isRecord(manifest.client) || !Array.isArray(manifest.files)) {
    throw new Error('Untrusted native extraction or SHA-256 mismatch')
  }
  const dumpText = readFileSync(path.join(directory, 'native-registrations.json'), 'utf8')
  const files: unknown[] = manifest.files.filter(
    (file: unknown) => isRecord(file) && file.path === 'native-registrations.json'
  )
  if (
    manifest.format !== 1 ||
    manifest.client.original_executable_sha256 !== expectedExecutable ||
    files.length !== 1 ||
    !isRecord(files[0]) ||
    sha(dumpText) !== files[0].sha256
  ) {
    throw new Error('Untrusted native extraction or SHA-256 mismatch')
  }
  const dump: unknown = JSON.parse(dumpText)
  if (
    !isRecord(dump) ||
    dump.format !== 1 ||
    dump.executable_sha256 !== expectedExecutable ||
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
    decisionHash: sha(decisionText),
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
