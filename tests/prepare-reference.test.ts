import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { expect, test } from 'vite-plus/test'

import { createReleaseFixture, sealReleaseFixture } from './release-fixture.ts'

function readReport(file: string): {
  uncompressed_bytes: unknown
  compressed_bytes: unknown
  compressed_sha256: unknown
  compressed_250_mb_gate_passed: unknown
  timings_seconds: { compression: unknown }
  build_seconds: unknown
} {
  const report: unknown = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(typeof report === 'object' && report !== null)
  assert.ok(
    'uncompressed_bytes' in report && 'compressed_bytes' in report && 'compressed_sha256' in report
  )
  assert.ok('compressed_250_mb_gate_passed' in report && 'build_seconds' in report)
  assert.ok(
    'timings_seconds' in report &&
      typeof report.timings_seconds === 'object' &&
      report.timings_seconds !== null
  )
  assert.ok('compression' in report.timings_seconds)
  return { ...report, timings_seconds: report.timings_seconds }
}

function readGate(file: string): { version: unknown } {
  const gate: unknown = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(typeof gate === 'object' && gate !== null && 'version' in gate)
  return gate
}

test('preparation versions, validates and measures the final compressed reference', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prepare-reference-'))

  try {
    const database = path.join(dir, 'wotlk.sqlite')
    const asset = `${database}.br`

    createReleaseFixture(database)
    sealReleaseFixture(database)
    writeFileSync(asset, brotliCompressSync(readFileSync(database)))
    writeFileSync(
      path.join(dir, 'build-report.json'),
      JSON.stringify({ build_seconds: 1, timings_seconds: { compression: 0.1 } })
    )

    const versions = path.join(dir, 'versions.json')

    writeFileSync(versions, JSON.stringify(['1.0.0']))

    const result = spawnSync(
      process.execPath,
      ['scripts/prepare-reference.ts', dir, `--used-versions=${versions}`],
      { encoding: 'utf8' }
    )

    expect(result.status).toBe(0)

    const final = readFileSync(database)
    const compressed = readFileSync(asset)

    expect(brotliDecompressSync(compressed)).toEqual(final)

    const verified = new DatabaseSync(database, { readOnly: true })

    expect(verified.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe(
      '1.0.1'
    )
    verified.close()

    const report = readReport(path.join(dir, 'build-report.json'))
    const gate = readGate(path.join(dir, 'gate.json'))

    expect(gate.version).toBe('1.0.1')
    expect(report.uncompressed_bytes).toBe(statSync(database).size)
    expect(report.compressed_bytes).toBe(compressed.length)
    expect(report.compressed_sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
    expect(report.compressed_250_mb_gate_passed).toBe(true)
    expect(report.timings_seconds.compression).toBeGreaterThanOrEqual(0.1)
    expect(report.build_seconds).toBeGreaterThanOrEqual(1)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
})
