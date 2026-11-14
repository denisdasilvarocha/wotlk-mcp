import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { writeReferenceArtifact } from './reference-artifact.ts'

const [argument, ...extra] = process.argv.slice(2).filter((arg) => arg !== '--')
if (!argument || extra.length)
  throw new Error('Usage: vpx scripts/complete-reference.ts <new-output-directory>')
const output = path.resolve(argument)
mkdirSync(output)
const database = path.join(output, 'wotlk.sqlite')
const inputs = path.join(output, 'inputs')
const world = path.join(output, 'world')
const timings: Record<string, number> = {}
const started = Date.now()
function run(label: string, command: string, args: string[]): void {
  const start = Date.now()
  console.error(`Starting ${label}`)
  execFileSync(command, args, { stdio: 'inherit' })
  timings[label] = (Date.now() - start) / 1000
}
function script(label: string, name: string, ...args: string[]): void {
  run(label, 'vpx', [`scripts/${name}.ts`, ...args])
}
let container: string | undefined
let failure: unknown
try {
  script('acquire and verify inputs', 'reference-inputs', inputs)
  const { client, clientManifestHash, wowdbdefs, azerothcore, codex } = z
    .object({
      client: z.string(),
      clientManifestHash: z.string(),
      wowdbdefs: z.string(),
      azerothcore: z.string(),
      codex: z.string()
    })
    .parse(JSON.parse(readFileSync(path.join(inputs, 'inputs.json'), 'utf8')))
  container = `wotlk-world-${randomBytes(16).toString('hex')}`
  run('reproduce world', 'sh', ['world/reproduce.sh', azerothcore, world, container])
  script('offsets', 'init-reference', database)
  run('codex', 'node', ['scripts/import-codex.ts', database, codex])
  script('client data', 'import-client-data', database, client, clientManifestHash, wowdbdefs)
  script('interface', 'import-interface', database, client, clientManifestHash)
  script('world', 'export-world', container, database)
  script(
    'native',
    'import-native',
    database,
    client,
    clientManifestHash,
    'data/native-widget-decisions.json'
  )
  script('world links', 'build-world-links', database)
  script('loot links', 'build-loot', database)
  script('client and spawn links', 'build-client-faction-spawn-links', database)
  script('world enums', 'import-world-enums', database, azerothcore)
  script('spell enums and foreign keys', 'import-spell-enums', database, azerothcore)
  script('fidelity report', 'reference-fidelity', database, path.join(output, 'fidelity.json'))
  script('provenance and notices', 'reference-provenance', database, path.join(output, 'NOTICE.md'))
  await writeReferenceArtifact(output, timings, started)
} catch (error) {
  failure = error
} finally {
  if (container)
    for (const args of [
      ['rm', '-f', container],
      ['network', 'rm', container]
    ])
      try {
        execFileSync('docker', args, { stdio: 'inherit' })
      } catch (error) {
        failure ??= error
      }
}
if (failure) throw failure
