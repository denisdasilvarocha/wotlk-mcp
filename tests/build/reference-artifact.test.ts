import { compressReferenceArtifact, writeBuildReport } from '../../build/reference/artifact.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'
import { expect, test } from 'vite-plus/test'

function readReport(file: string): {
  uncompressed_bytes: unknown
  compressed_bytes: unknown
  compressed_sha256: unknown
  timings_seconds: { acquisition: unknown; compression: unknown } & Record<string, unknown>
  build_seconds: unknown
} {
  const report: unknown = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(typeof report === 'object' && report !== null)
  assert.ok(
    'uncompressed_bytes' in report && 'compressed_bytes' in report && 'compressed_sha256' in report
  )
  assert.ok(
    'timings_seconds' in report &&
      typeof report.timings_seconds === 'object' &&
      report.timings_seconds !== null
  )
  assert.ok('acquisition' in report.timings_seconds && 'compression' in report.timings_seconds)
  assert.ok('build_seconds' in report)
  return { ...report, timings_seconds: report.timings_seconds }
}

test('compresses the database and reports the actual artifact and timings', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-'))

  try {
    const database = path.join(dir, 'wotlk.sqlite')
    const db = new DatabaseSync(database)

    db.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('artifact fixture')")
    db.close()

    const started = Date.now()

    const artifact = await compressReferenceArtifact(dir)
    const timings = { acquisition: 1.25, 'compressed reference': 2, 'server and SQL worker': 3 }
    expect(readdirSync(dir)).not.toContain('build-report.json')
    writeBuildReport(dir, artifact, timings, started, 2)

    const original = readFileSync(database)
    const compressed = readFileSync(path.join(dir, 'wotlk.sqlite.br'))

    expect(brotliDecompressSync(compressed)).toEqual(original)

    const report = readReport(path.join(dir, 'build-report.json'))

    expect(report.uncompressed_bytes).toBe(original.length)
    expect(report.compressed_bytes).toBe(compressed.length)
    expect(report.compressed_sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
    expect(report.timings_seconds.acquisition).toBe(1.25)
    expect(report.timings_seconds.compression).toBeGreaterThanOrEqual(0)
    expect(report.timings_seconds['compressed reference']).toBe(2)
    expect(report.timings_seconds['server and SQL worker']).toBe(3)
    expect(report.build_seconds).toBeGreaterThanOrEqual(2)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})

test('missing database leaves no artifact, report or temporary output', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-missing-'))

  try {
    writeFileSync(path.join(dir, 'sentinel'), 'untouched')
    await expect(compressReferenceArtifact(dir)).rejects.toThrow(/ENOENT/u)
    expect(readdirSync(dir)).toEqual(['sentinel'])
    expect(readFileSync(path.join(dir, 'sentinel'), 'utf8')).toBe('untouched')
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
