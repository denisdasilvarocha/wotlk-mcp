import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { writeReferenceArtifact } from './artifact.ts'
import { writeFidelity } from './fidelity.ts'
import { runImportStages } from './main-import-stages.ts'
import { runLinkStages } from './main-link-stages.ts'
import { writeProvenance } from './provenance.ts'
import { acquireSources } from './sources.ts'

const usage = `Usage: vp run build [new-output-directory]

Default output directory: output
The destination must not exist; partial builds are retained and cannot be resumed.
Prerequisites: Node >=24.15.0, Vite+, Git, Python 3, tar, authenticated gh
with release-read access, and Docker/Buildx with linux/amd64 execution.
For a subsequent build: vp run build ./output-next`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function createOutput(output: string): void {
  try {
    mkdirSync(output)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Output already exists: ${output}. Nothing was changed. Build into a new directory, for example: vp run build ./output-next.`,
        { cause: error }
      )
    }

    throw error
  }
}

export async function buildReference(directory: string): Promise<void> {
  const output = path.resolve(directory)
  createOutput(output)
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

    await runImportStages(run, database, output, sources)
    await runLinkStages(run, database, sources.azerothcore.directory)
    await run('fidelity report', () => {
      writeFidelity(database, path.join(output, 'fidelity.json'))
    })
    await run('provenance and notices', () => {
      writeProvenance(database, path.join(output, 'NOTICE.md'), sources)
    })
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

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    const args = process.argv.slice(2)

    if (args.length === 1 && args[0] === '--help') {
      console.log(usage)
    } else {
      if (args.length > 1 || args.some((argument) => argument.startsWith('-'))) {
        throw new Error(`Invalid build arguments.\n${usage}`)
      }

      await buildReference(args[0] ?? 'output')
    }
  } catch (error) {
    console.error(error)
    process.exitCode ??= 1
  }
}
