import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants, createBrotliCompress } from 'node:zlib'

const [argument, ...extra] = process.argv.slice(2).filter((arg) => arg !== '--')
if (!argument || extra.length) throw new Error('Usage: vpx scripts/complete-reference.ts <new-output-directory>')
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
const manifest = 'e5db5940f6e7ca8b3862c5c27b1a08cdc45571d79bd2ba9607540a5e432f3235'
const client = path.join(inputs, 'client-inputs')
const core = path.join(inputs, 'azerothcore.tar.gz')
let container: string | undefined
try {
  script('acquire and verify inputs', 'reference-inputs', inputs)
  run('reproduce world', 'sh', ['world/reproduce.sh', core, world])
  const report = readFileSync(path.join(world, 'report.txt'), 'utf8')
  container = /^container=(wotlk-world-[A-Za-z0-9]+)$/m.exec(report)?.[1]
  if (!container) throw new Error('World reproduction did not identify its container')
  script('offsets', 'build-reference', database)
  run('codex', 'node', ['scripts/import-codex.ts', database, path.join(inputs, 'codex')])
  script('client data', 'import-client-data', database, client, manifest, path.join(inputs, 'wowdbdefs.tar.gz'))
  script('interface', 'import-interface', database, client, manifest)
  script('world', 'export-world', container, database)
  script('native', 'import-native', database, client, manifest, 'data/native-widget-decisions.json')
  script('world links', 'build-world-links', database)
  script('loot links', 'build-loot', database)
  script('client and spawn links', 'build-client-faction-spawn-links', database)
  script('world enums', 'import-world-enums', database, core)
  script('spell enums and foreign keys', 'import-spell-enums', database, core)
  script('fidelity report', 'reference-fidelity', database, path.join(output, 'fidelity.json'))
  script('provenance and notices', 'reference-provenance', database, path.join(output, 'NOTICE.md'))
  const compressed = path.join(output, 'wotlk.sqlite.br')
  const compressionStart = Date.now()
  await pipeline(createReadStream(database), createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }), createWriteStream(compressed, { flags: 'wx' }))
  timings.compression = (Date.now() - compressionStart) / 1000
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(compressed)) hash.update(chunk)
  const summary = {
    build_seconds: (Date.now() - started) / 1000,
    timings_seconds: timings,
    uncompressed_bytes: statSync(database).size,
    compressed_bytes: statSync(compressed).size,
    compressed_sha256: hash.digest('hex'),
    compressed_250_mb_gate_passed: statSync(compressed).size <= 250_000_000
  }
  writeFileSync(path.join(output, 'build-report.json'), `${JSON.stringify(summary, null, 2)}\n`)
  if (!summary.compressed_250_mb_gate_passed) console.error('Compressed asset exceeds 250 MB; an explicit scope decision is required before publication.')
} finally {
  if (container) {
    execFileSync('docker', ['rm', '-f', container], { stdio: 'inherit' })
    execFileSync('docker', ['network', 'rm', container], { stdio: 'inherit' })
  }
}
