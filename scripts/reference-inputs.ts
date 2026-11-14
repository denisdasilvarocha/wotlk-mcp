import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.length !== 1) throw new Error('Usage: node scripts/reference-inputs.ts <new-directory>')
const output = path.resolve(args[0])
const clientAsset = 'client-inputs-12340-engb-1.tar.gz'
const clientManifestHash = 'e5db5940f6e7ca8b3862c5c27b1a08cdc45571d79bd2ba9607540a5e432f3235'
const wowRevision = 'fe771f93091b18db417c99621cfe9e36a228a590'
const worldRevision = '2948c203faa0d23c4772441119ebe98e5b7cad95'
const codexFiles = ['api-functions', 'events', 'widgets', 'cvars', 'data-types', 'combat-log-events', 'secure-templates', 'book-chapters'].map((name) => `src/data/${name}.ts`)
const pins: { revision: string; files: Record<string, string> } = JSON.parse(readFileSync(path.join(root, 'data/codex-pins.json'), 'utf8'))
if (!/^[a-f0-9]{40}$/.test(pins.revision) || codexFiles.some((file) => !/^[a-f0-9]{64}$/.test(pins.files[file] ?? '')) || Object.keys(pins.files).length !== codexFiles.length)
  throw new Error('Invalid Codex pin manifest')

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function verify(file: string, expected: string): Promise<void> {
  if (await sha256(file) !== expected) throw new Error(`SHA-256 mismatch: ${file}`)
}
function run(command: string, commandArgs: string[]): string {
  return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

// Never reuse a directory that might contain unverified or unrelated files.
mkdirSync(output, { mode: 0o700 })
try {
  run('gh', ['release', 'download', 'client-inputs-12340-engb-1', '--repo', 'denisdasilvarocha/wotlk-mcp', '--pattern', clientAsset, '--dir', output])
  const bundle = path.join(output, clientAsset)
  run('python3', [path.join(root, 'scripts/verify-client-inputs.py'), bundle])
  const client = path.join(output, 'client-inputs')
  mkdirSync(client, { mode: 0o700 })
  run('tar', ['-xzf', bundle, '-C', client])
  const wow = path.join(output, 'wowdbdefs.tar.gz')
  const world = path.join(output, 'azerothcore.tar.gz')
  run('curl', ['-fL', `https://codeload.github.com/wowdev/WoWDBDefs/tar.gz/${wowRevision}`, '-o', wow])
  await verify(wow, 'b35205cb31c27204f05ae8528ca214af02381585f5d0d2697bea30a2d58123ca')
  run('curl', ['-fL', `https://codeload.github.com/azerothcore/azerothcore-wotlk/tar.gz/${worldRevision}`, '-o', world])
  await verify(world, '748a228d62fb2bf7203a193a4b622e3299fb78a3537ae1a150eda9091c1cf7f9')
  const codex = path.join(output, 'codex')
  run('git', ['init', '-q', codex])
  run('git', ['-C', codex, 'fetch', '-q', '--depth', '1', 'https://github.com/Shard-MW/milkyway-codex.git', pins.revision])
  run('git', ['-C', codex, 'checkout', '-q', '--detach', 'FETCH_HEAD'])
  if (run('git', ['-C', codex, 'rev-parse', 'HEAD']) !== pins.revision) throw new Error('Codex revision mismatch')
  await Promise.all(codexFiles.map((file) => verify(path.join(codex, file), pins.files[file])))
  const result = { client, clientManifestHash, clientBundle: bundle, wowdbdefs: wow, azerothcore: world, codex, codexRevision: pins.revision }
  writeFileSync(path.join(output, 'inputs.json'), `${JSON.stringify(result, undefined, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify(result))
} catch (error) {
  rmSync(output, { recursive: true, force: true })
  throw error
}
