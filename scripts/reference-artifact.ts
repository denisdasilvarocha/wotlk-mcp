import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants, createBrotliCompress } from 'node:zlib'

export async function writeReferenceArtifact(
  output: string,
  timings: Record<string, number>,
  started: number,
  previousSeconds = 0
): Promise<void> {
  const database = path.join(output, 'wotlk.sqlite')
  const compressed = path.join(output, 'wotlk.sqlite.br')
  const temporary = `${compressed}.${randomBytes(8).toString('hex')}.tmp`
  const compressionStart = Date.now()
  try {
    await pipeline(
      createReadStream(database),
      createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
      createWriteStream(temporary, { flags: 'wx' })
    )
    renameSync(temporary, compressed)
  } finally {
    rmSync(temporary, { force: true })
  }
  timings.compression = (timings.compression ?? 0) + (Date.now() - compressionStart) / 1000
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(compressed)) hash.update(chunk)
  const compressedBytes = statSync(compressed).size
  const summary = {
    build_seconds: previousSeconds + (Date.now() - started) / 1000,
    timings_seconds: timings,
    brotli_quality: 5,
    uncompressed_bytes: statSync(database).size,
    compressed_bytes: compressedBytes,
    compressed_sha256: hash.digest('hex'),
    compressed_250_mb_gate_passed: compressedBytes <= 250_000_000
  }
  writeFileSync(
    path.join(output, 'build-report.json'),
    `${JSON.stringify(summary, undefined, 2)}\n`
  )
  if (!summary.compressed_250_mb_gate_passed)
    console.error(
      'Compressed asset exceeds 250 MB; an explicit scope decision is required before publication.'
    )
}
