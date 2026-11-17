import { isRecord } from './record.ts'
import { sha256Hex } from './sha256.ts'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** SHA-256 of the original build 12340 client executable the inputs were extracted from. */
export const clientExecutableSha256 =
  'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'

export type ClientManifestFile = Readonly<{ path: string; sha256: string; archive?: unknown }>

function isManifestFile(value: unknown): value is ClientManifestFile {
  return isRecord(value) && typeof value.path === 'string' && typeof value.sha256 === 'string'
}

// Reads the extracted client inputs' manifest.json after checking its pinned SHA-256 and the build 12340 enGB fingerprint.
export function readClientManifest(
  directory: string,
  manifestHash: string
): readonly ClientManifestFile[] {
  if (!/^[a-f0-9]{64}$/u.test(manifestHash)) {
    throw new Error('Expected lowercase SHA-256 of the trusted manifest')
  }

  const bytes = readFileSync(path.join(directory, 'manifest.json'))

  if (sha256Hex(bytes) !== manifestHash) {
    throw new Error('Client manifest SHA-256 mismatch')
  }

  const manifest: unknown = JSON.parse(bytes.toString('utf8'))

  if (
    !isRecord(manifest) ||
    manifest.format !== 1 ||
    !isRecord(manifest.client) ||
    manifest.client.build !== 12340 ||
    manifest.client.locale !== 'enGB' ||
    manifest.client.original_executable_sha256 !== clientExecutableSha256
  ) {
    throw new Error('Unsupported client manifest or fingerprint')
  }

  if (!Array.isArray(manifest.files) || !manifest.files.every(isManifestFile)) {
    throw new TypeError('Invalid client manifest files')
  }

  return manifest.files
}
