import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const eligible = /^Interface\/(?:FrameXML|GlueXML|AddOns\/Blizzard_[^/]+)\/.+\.(?:lua|xml|toc)$/iu
const executable = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'

export interface InterfaceFile {
  path: string
  archive: unknown
  sha256: unknown
}

export function digest(bytes: Readonly<Pick<Buffer, 'subarray'>>): string {
  return createHash('sha256').update(bytes.subarray()).digest('hex')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInterfaceFile(value: unknown): value is InterfaceFile {
  if (value === null) {
    throw new TypeError("Cannot read properties of null (reading 'path')")
  }

  if (!isObject(value)) {
    return false
  }

  if (typeof value.path !== 'string') {
    if (eligible.test(String(value.path))) {
      throw new TypeError('Interface path is not a string')
    }

    return false
  }

  return eligible.test(value.path)
}

export function interfaceFiles(directory: string, manifestHash: string): InterfaceFile[] {
  if (!/^[a-f0-9]{64}$/u.test(manifestHash)) {
    throw new Error('Expected lowercase SHA-256 of the trusted manifest')
  }

  const bytes = readFileSync(path.join(directory, 'manifest.json'))

  if (digest(bytes) !== manifestHash) {
    throw new Error('Client manifest SHA-256 mismatch')
  }

  const manifest: unknown = JSON.parse(bytes.toString('utf8'))

  if (
    !isObject(manifest) ||
    manifest.format !== 1 ||
    !isObject(manifest.client) ||
    manifest.client.build !== 12340 ||
    manifest.client.locale !== 'enGB' ||
    manifest.client.original_executable_sha256 !== executable ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('Unsupported client manifest or fingerprint')
  }

  const files = manifest.files
    .filter((file: unknown): file is InterfaceFile => isInterfaceFile(file))
    .toSorted((a: Readonly<InterfaceFile>, b: Readonly<InterfaceFile>) =>
      a.path.localeCompare(b.path, 'en')
    )

  if (
    files.length === 0 ||
    new Set(files.map((file: Readonly<InterfaceFile>) => file.path.toLowerCase())).size !==
      files.length
  ) {
    throw new Error('Empty or duplicate Interface inventory')
  }

  return files
}
