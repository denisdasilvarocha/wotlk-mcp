import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { writeReferenceArtifact } from '../build/artifact.ts'

const [directory, ...options] = process.argv.slice(2).filter((arg) => arg !== '--')

if (!directory) {
  throw new Error(
    'Usage: vpx scripts/prepare-reference.ts <candidate-directory> [previous.sqlite] [--allow-shrink] [--used-versions=versions.json]'
  )
}

if (options.includes('--prepare')) {
  throw new Error('Unknown option: --prepare')
}
const output = path.resolve(directory)
const database = path.join(output, 'wotlk.sqlite')
const asset = path.join(output, 'wotlk.sqlite.br')
const report = path.join(output, 'build-report.json')

const original = z
  .object({
    build_seconds: z.number(),
    timings_seconds: z.record(z.string(), z.number())
  })
  .parse(JSON.parse(readFileSync(report, 'utf8')))

const started = Date.now()
const args = ['scripts/release-gate.ts', database, asset, ...options]
rmSync(path.join(output, 'gate.json'), { force: true })
execFileSync(process.execPath, [...args, '--prepare'], { encoding: 'utf8' })
await writeReferenceArtifact(output, original.timings_seconds, started, original.build_seconds)
const gate = execFileSync(process.execPath, args, { encoding: 'utf8' })
writeFileSync(path.join(output, 'gate.json'), gate)
const finalReport = z
  .record(z.string(), z.unknown())
  .parse(JSON.parse(readFileSync(report, 'utf8')))
finalReport.build_seconds = original.build_seconds + (Date.now() - started) / 1000
writeFileSync(report, `${JSON.stringify(finalReport, undefined, 2)}\n`)
