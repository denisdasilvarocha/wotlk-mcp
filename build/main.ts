import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeReferenceArtifact } from './artifact.ts'
import { buildClientFactionSpawnLinks } from './client-faction-spawn-links.ts'
import { importClientData } from './client.ts'
import { importCodex, readCodex } from './codex.ts'
import { writeFidelity } from './fidelity.ts'
import { importInterface } from './interface.ts'
import { buildLootLinks } from './loot-links.ts'
import { importNative } from './native.ts'
import { initReference } from './offsets.ts'
import { writeProvenance } from './provenance.ts'
import { acquireSources } from './sources.ts'
import { importSpellEnums } from './spell-enums.ts'
import { importWorldEnums } from './world-enums.ts'
import { buildWorldLinks } from './world-links.ts'
import { importWorld } from './world.ts'

const usage = `Usage: vp run build [new-output-directory]

Default output directory: output
The destination must not exist; partial builds are retained and cannot be resumed.
Prerequisites: Node >=24.15.0, Vite+, Git, Python 3, tar, authenticated gh
with release-read access, and Docker/Buildx with linux/amd64 execution.
For a subsequent build: vp run build ./output-next`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function buildReference(directory: string): Promise<void> {
  const output = path.resolve(directory)

  try {
    mkdirSync(output)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        `Output already exists: ${output}. Nothing was changed. Build into a new directory, for example: vp run build ./output-next.`,
        { cause: error }
      )

    throw error
  }

  const database = path.join(output, 'wotlk.sqlite')
  let stage = 'acquire and verify inputs'
  const started = Date.now()
  const timings: Record<string, number> = {}

  async function run<T>(label: string, action: () => T | Promise<T>): Promise<T> {
    stage = label

    const start = Date.now()

    console.error(`Starting ${label}`)

    const result = await action()

    timings[label] = (Date.now() - start) / 1000
    console.error(`Finished ${label} (${timings[label].toFixed(2)}s)`)

    return result
  }

  try {
    const sources = await run(stage, () => acquireSources(path.join(output, 'inputs')))

    await run('offsets', () => initReference(database))
    await run('codex', async () =>
      importCodex(database, sources.codex, await readCodex(sources.codex, sources.codexNodeImage))
    )
    await run('client data', () =>
      importClientData(database, sources.client, sources.clientManifestHash, sources.wowdbdefs)
    )
    await run('interface', () =>
      importInterface(database, sources.client, sources.clientManifestHash)
    )
    await run('world', () =>
      importWorld(
        database,
        sources.azerothcore,
        sources.worldImporterImage,
        path.join(output, 'world')
      )
    )
    await run('native', () =>
      importNative(
        database,
        sources.client,
        sources.clientManifestHash,
        'data/native-widget-decisions.json'
      )
    )
    await run('world links', () => buildWorldLinks(database))
    await run('loot links', () => buildLootLinks(database))
    await run('client and spawn links', () => buildClientFactionSpawnLinks(database))
    await run('world enums', () => importWorldEnums(database, sources.azerothcore.directory))
    await run('spell enums and foreign keys', () =>
      importSpellEnums(database, sources.azerothcore.directory)
    )
    await run('fidelity report', () => writeFidelity(database, path.join(output, 'fidelity.json')))
    await run('provenance and notices', () =>
      writeProvenance(database, path.join(output, 'NOTICE.md'), sources)
    )
    await run('compressed reference', () => writeReferenceArtifact(output, timings, started))
    await run('server and SQL worker', () => execFileSync('vp', ['pack'], { stdio: 'inherit' }))
  } catch (error) {
    throw new Error(
      `Build failed during ${stage}. Partial output retained at ${output}. World updater log, if created: ${path.join(output, 'world/updater.log')}`,
      { cause: error }
    )
  }

  console.log(`Database: ${database}`)
  console.log(
    `WOTLK_MCP_DB=${shellQuote(database)} node ${shellQuote(path.resolve('dist/index.mjs'))}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    const args = process.argv.slice(2)

    if (args.length === 1 && args[0] === '--help') console.log(usage)
    else {
      if (args.length > 1 || args.some((argument) => argument.startsWith('-')))
        throw new Error(`Invalid build arguments.\n${usage}`)

      await buildReference(args[0] ?? 'output')
    }
  } catch (error) {
    console.error(error)
    process.exitCode ??= 1
  }
