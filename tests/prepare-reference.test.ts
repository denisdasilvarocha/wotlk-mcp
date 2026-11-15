import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { expect, test } from 'vite-plus/test'

import { createReleaseFixture, sealReleaseFixture } from './release-fixture.ts'

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

    const report = JSON.parse(readFileSync(path.join(dir, 'build-report.json'), 'utf8'))
    const gate = JSON.parse(readFileSync(path.join(dir, 'gate.json'), 'utf8'))

    expect(gate.version).toBe('1.0.1')
    expect(report.uncompressed_bytes).toBe(statSync(database).size)
    expect(report.compressed_bytes).toBe(compressed.length)
    expect(report.compressed_sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
    expect(report.compressed_250_mb_gate_passed).toBe(true)
    expect(report.timings_seconds.compression).toBeGreaterThanOrEqual(0.1)
    expect(report.build_seconds).toBeGreaterThanOrEqual(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
