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

async function compressReference(database: string, compressed: string): Promise<number> {
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

  return (Date.now() - compressionStart) / 1000
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file) as AsyncIterable<unknown>) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError('Expected a Buffer from the file stream')
    }
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function writeReferenceArtifact(
  output: string,
  timings: Readonly<Record<string, number>>,
  started: number,
  previousSeconds = 0
): Promise<void> {
  const database = path.join(output, 'wotlk.sqlite')
  const compressed = path.join(output, 'wotlk.sqlite.br')
  const compression = await compressReference(database, compressed)
  Object.assign(timings, { compression: (timings.compression ?? 0) + compression })

  const compressedBytes = statSync(compressed).size
  const summary = {
    brotli_quality: 5,
    build_seconds: previousSeconds + (Date.now() - started) / 1000,
    compressed_250_mb_gate_passed: compressedBytes <= 250_000_000,
    compressed_bytes: compressedBytes,
    compressed_sha256: await hashFile(compressed),
    timings_seconds: timings,
    uncompressed_bytes: statSync(database).size
  }

  writeFileSync(
    path.join(output, 'build-report.json'),
    `${JSON.stringify(summary, undefined, 2)}\n`
  )

  if (!summary.compressed_250_mb_gate_passed) {
    console.error(
      'Compressed asset exceeds 250 MB; an explicit scope decision is required before publication.'
    )
  }
}
