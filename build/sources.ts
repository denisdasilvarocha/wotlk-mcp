import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

const clientAsset = 'client-inputs-12340-engb-1.tar.gz'
const clientManifestHash = 'e5db5940f6e7ca8b3862c5c27b1a08cdc45571d79bd2ba9607540a5e432f3235'
const clientRelease = 'client-inputs-12340-engb-1'
const clientRepository = 'denisdasilvarocha/wotlk-mcp'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

export function hashCodex(
  directory: string,
  expected?: Record<string, string>
): Pick<CodexSource, 'files' | 'sha256'> {
  const aggregate = createHash('sha256')
  const files: Record<string, string> = {}

  for (const name of codexNames) {
    const file = `src/data/${name}.ts`
    const bytes = readFileSync(path.join(directory, file))
    const digest = createHash('sha256').update(bytes).digest('hex')

    if (expected && digest !== expected[file]) throw new Error(`Codex SHA-256 mismatch: ${file}`)

    files[file] = digest
    aggregate.update(file).update('\0').update(bytes)
  }

  return { files, sha256: aggregate.digest('hex') }
}

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
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) })
    .safeParse(await (await response(url)).json())

  if (!data.success) throw new Error(`Invalid commit revision from ${url}`)

  return data.data.sha.toLowerCase()
}

async function response(url: string): Promise<Response> {
  const result = await fetch(url, { headers: { 'User-Agent': 'wotlk-mcp-build' } })

  if (!result.ok) throw new Error(`Download failed: ${url}: HTTP ${result.status}`)

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

  if (!result.body) throw new Error(`Empty archive response: ${url}`)

  const file = path.join(output, `${name}.tar.gz`)
  const destination = await open(file, 'wx')
  const hash = createHash('sha256')

  try {
    for await (const chunk of result.body) {
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

  return { directory, archive: file, revision: commit, sha256: hash.digest('hex') }
}

function run(command: string, commandArgs: string[]): string {
  return execFileSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

function image(reference: string, name: string): string {
  try {
    const manifest = z
      .object({
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        manifests: z
          .array(
            z.object({
              platform: z
                .object({ os: z.string().optional(), architecture: z.string().optional() })
                .optional()
            })
          )
          .optional()
      })
      .parse(
        JSON.parse(
          run('docker', [
            'buildx',
            'imagetools',
            'inspect',
            reference,
            '--format',
            '{{json .Manifest}}'
          ])
        )
      )

    if (
      name !== 'node' &&
      !manifest.manifests?.some(
        (entry) => entry.platform?.os === 'linux' && entry.platform.architecture === 'amd64'
      )
    )
      throw new Error(`Image ${reference}@${manifest.digest} has no linux/amd64 platform`)

    return `${name}@${manifest.digest}`
  } catch (error) {
    throw new Error(`Cannot resolve image ${reference}: ${String(error)}`, { cause: error })
  }
}

function worldRevision(imageReference: string): string {
  try {
    const slsa = z.object({
      buildDefinition: z.object({
        externalParameters: z.object({
          request: z.object({
            root: z.object({
              request: z.object({
                args: z.object({
                  'vcs:source': z.literal('https://github.com/azerothcore/azerothcore-wotlk'),
                  'vcs:revision': z.string().regex(/^[a-f0-9]{40}$/i)
                })
              })
            })
          })
        })
      })
    })
    const provenance = z
      .object({
        SLSA: slsa.optional(),
        'linux/amd64': z.object({ SLSA: slsa }).optional()
      })
      .parse(
        JSON.parse(
          run('docker', [
            'buildx',
            'imagetools',
            'inspect',
            imageReference,
            '--format',
            '{{json .Provenance}}'
          ])
        )
      )
    let selected = provenance.SLSA

    selected ??= provenance['linux/amd64']?.SLSA

    if (!selected) throw new Error('missing linux/amd64 SLSA source revision')

    return selected.buildDefinition.externalParameters.request.root.request.args[
      'vcs:revision'
    ].toLowerCase()
  } catch (error) {
    throw new Error(`Invalid provenance for ${imageReference}: ${String(error)}`, { cause: error })
  }
}

export async function acquireSources(directory: string): Promise<Sources> {
  const output = path.resolve(directory)

  mkdirSync(output, { mode: 0o700 })

  try {
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

    run('python3', [path.join(root, 'build/verify-client-inputs.py'), bundle])

    const client = path.join(output, 'client-inputs')

    mkdirSync(client, { mode: 0o700 })
    run('tar', ['-xzf', bundle, '-C', client])

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

    if (run('git', ['-C', codexDirectory, 'rev-parse', 'HEAD']) !== codexRevision)
      throw new Error(`Codex revision mismatch: expected ${codexRevision}`)

    const { files, sha256 } = hashCodex(codexDirectory)

    console.log(
      `WoWDBDefs ${wowRevision}; AzerothCore ${worldCommit} (${worldImporterImage}); Codex ${codexRevision} (${codexNodeImage})`
    )

    return {
      client,
      clientManifestHash,
      wowdbdefs,
      azerothcore,
      worldImporterImage,
      codex: {
        directory: codexDirectory,
        revision: codexRevision,
        files,
        sha256
      },
      codexNodeImage
    }
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  }
}
