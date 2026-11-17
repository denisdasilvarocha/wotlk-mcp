import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { sha256Hex } from '../shared/sha256.ts'
import { image, run, worldRevision } from './images.ts'

const clientAsset = 'client-inputs-12340-engb-1.tar.gz'

const clientManifestHash = 'e5db5940f6e7ca8b3862c5c27b1a08cdc45571d79bd2ba9607540a5e432f3235'

const clientRelease = 'client-inputs-12340-engb-1'

const clientRepository = 'denisdasilvarocha/wotlk-mcp'

const root = path.resolve(import.meta.dirname, '../..')

export const codexNames = [
  'api-functions',
  'events',
  'widgets',
  'cvars',
  'data-types',
  'combat-log-events',
  'secure-templates',
  'book-chapters'
]

export interface CodexSource {
  directory: string
  revision: string
  files: Record<string, string>
  sha256: string
}

export interface SourceArchive {
  directory: string
  archive: string
  revision: string
  sha256: string
}

export interface Sources {
  client: string
  clientManifestHash: string
  wowdbdefs: SourceArchive
  azerothcore: SourceArchive
  worldImporterImage: string
  codex: CodexSource
  codexNodeImage: string
}

async function revision(repository: string, branch: string): Promise<string> {
  const url = `https://api.github.com/repos/${repository}/commits/${branch}`
  const data = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/iu) })
    .safeParse(await (await response(url)).json())

  if (!data.success) {
    throw new Error(`Invalid commit revision from ${url}`)
  }

  return data.data.sha.toLowerCase()
}

async function response(url: string): Promise<Response> {
  const result = await fetch(url, { headers: { 'User-Agent': 'wotlk-mcp-build' } })

  if (!result.ok) {
    throw new Error(`Download failed: ${url}: HTTP ${result.status}`)
  }

  return result
}

async function archive(
  output: string,
  name: string,
  repository: string,
  commit: string
): Promise<SourceArchive> {
  const url = `https://codeload.github.com/${repository}/tar.gz/${commit}`
  const result = await response(url)

  if (!result.body) {
    throw new Error(`Empty archive response: ${url}`)
  }

  const file = path.join(output, `${name}.tar.gz`)
  const destination = await open(file, 'wx')
  const hash = createHash('sha256')

  try {
    for await (const chunk of result.body as ReadableStream<Uint8Array>) {
      hash.update(chunk)
      await destination.writeFile(chunk)
    }
  } finally {
    await destination.close()
  }

  const directory = path.join(output, name)

  // Public sources; Linux containers read the bind mount as a different user.
  mkdirSync(directory, { mode: 0o755 })
  run('tar', ['-xzf', file, '-C', directory, '--strip-components=1'])

  return { archive: file, directory, revision: commit, sha256: hash.digest('hex') }
}

function acquireClient(output: string): string {
  try {
    run('gh', [
      'release',
      'download',
      clientRelease,
      '--repo',
      clientRepository,
      '--pattern',
      clientAsset,
      '--dir',
      output
    ])
  } catch (error) {
    throw new Error(
      `Cannot download ${clientRepository} release ${clientRelease} asset ${clientAsset}; authenticated release-read access is required: ${String(error)}`,
      { cause: error }
    )
  }
  const bundle = path.join(output, clientAsset)
  run('python3', [path.join(root, 'build/sources/verify-client-inputs.py'), bundle])
  const client = path.join(output, 'client-inputs')
  mkdirSync(client, { mode: 0o700 })
  run('tar', ['-xzf', bundle, '-C', client])
  return client
}

function acquireCodex(output: string, codexRevision: string): CodexSource {
  const codexDirectory = path.join(output, 'codex')
  run('git', ['init', '-q', codexDirectory])
  run('git', [
    '-C',
    codexDirectory,
    'fetch',
    '-q',
    '--depth',
    '1',
    'https://github.com/Shard-MW/milkyway-codex.git',
    codexRevision
  ])
  run('git', ['-C', codexDirectory, 'checkout', '-q', '--detach', 'FETCH_HEAD'])
  if (run('git', ['-C', codexDirectory, 'rev-parse', 'HEAD']) !== codexRevision) {
    throw new Error(`Codex revision mismatch: expected ${codexRevision}`)
  }
  const { files, sha256 } = hashCodex(codexDirectory)
  return { directory: codexDirectory, files, revision: codexRevision, sha256 }
}

export function hashCodex(
  directory: string,
  expected?: Readonly<Record<string, string>>
): Pick<CodexSource, 'files' | 'sha256'> {
  const aggregate = createHash('sha256')
  const files: Record<string, string> = {}

  for (const name of codexNames) {
    const file = `src/data/${name}.ts`
    const bytes = readFileSync(path.join(directory, file))
    const digest = sha256Hex(bytes)

    if (expected && digest !== expected[file]) {
      throw new Error(`Codex SHA-256 mismatch: ${file}`)
    }

    files[file] = digest
    aggregate.update(file).update('\0').update(bytes)
  }

  return { files, sha256: aggregate.digest('hex') }
}

export async function acquireSources(directory: string): Promise<Sources> {
  const output = path.resolve(directory)

  mkdirSync(output, { mode: 0o700 })

  try {
    const client = acquireClient(output)

    const wowRevision = await revision('wowdev/WoWDBDefs', 'master')
    const wowdbdefs = await archive(output, 'wowdbdefs', 'wowdev/WoWDBDefs', wowRevision)
    const worldImporterImage = image('acore/ac-wotlk-db-import:master', 'acore/ac-wotlk-db-import')
    const worldCommit = worldRevision(worldImporterImage)
    const azerothcore = await archive(
      output,
      'azerothcore',
      'azerothcore/azerothcore-wotlk',
      worldCommit
    )
    const codexNodeImage = image('node:24-alpine', 'node')
    const codexRevision = await revision('Shard-MW/milkyway-codex', 'main')
    const codex = acquireCodex(output, codexRevision)

    console.log(
      `WoWDBDefs ${wowRevision}; AzerothCore ${worldCommit} (${worldImporterImage}); Codex ${codexRevision} (${codexNodeImage})`
    )

    return {
      azerothcore,
      client,
      clientManifestHash,
      codex,
      codexNodeImage,
      worldImporterImage,
      wowdbdefs
    }
  } catch (error) {
    rmSync(output, { force: true, recursive: true })
    throw error
  }
}
