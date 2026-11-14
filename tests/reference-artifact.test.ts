import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { brotliDecompressSync } from 'node:zlib'

import { expect, test } from 'vite-plus/test'

import { writeReferenceArtifact } from '../build/artifact.ts'

test('compresses the database and reports the actual artifact and timings', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-'))
  try {
    const database = path.join(dir, 'wotlk.sqlite')
    const db = new DatabaseSync(database)
    db.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('artifact fixture')")
    db.close()
    const started = Date.now()
    await writeReferenceArtifact(dir, { acquisition: 1.25 }, started, 2)
    const original = readFileSync(database)
    const compressed = readFileSync(path.join(dir, 'wotlk.sqlite.br'))
    expect(brotliDecompressSync(compressed)).toEqual(original)
    const report = JSON.parse(readFileSync(path.join(dir, 'build-report.json'), 'utf8'))
    expect(report.uncompressed_bytes).toBe(original.length)
    expect(report.compressed_bytes).toBe(compressed.length)
    expect(report.compressed_sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
    expect(report.timings_seconds.acquisition).toBe(1.25)
    expect(report.timings_seconds.compression).toBeGreaterThanOrEqual(0)
    expect(report.build_seconds).toBeGreaterThanOrEqual(2)
    const decompressed = path.join(dir, 'roundtrip.sqlite')
    writeFileSync(decompressed, brotliDecompressSync(compressed))
    const restored = new DatabaseSync(decompressed, { readOnly: true })
    try {
      expect(restored.prepare('SELECT value FROM marker').get()).toEqual({
        value: 'artifact fixture'
      })
    } finally {
      restored.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing database leaves no artifact, report or temporary output', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'artifact-missing-'))
  try {
    writeFileSync(path.join(dir, 'sentinel'), 'untouched')
    await expect(writeReferenceArtifact(dir, {}, Date.now())).rejects.toThrow(/ENOENT/)
    expect(readdirSync(dir)).toEqual(['sentinel'])
    expect(readFileSync(path.join(dir, 'sentinel'), 'utf8')).toBe('untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
