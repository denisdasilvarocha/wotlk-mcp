import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vite-plus/test'

test('client extraction rejects an untrusted executable before opening archives', () => {
  const root = mkdtempSync(join(tmpdir(), 'client-extraction-'))
  try {
    writeFileSync(join(root, 'Wow_Original.exe'), 'not the trusted client')
    const result = spawnSync('python3', ['extract-client.py', root, join(root, 'output'), 'missing-library'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('fingerprint mismatch')
    expect(existsSync(join(root, 'output'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const library = process.env.STORMLIB_TEST_LIBRARY ?? ['/opt/homebrew/lib/libstorm.dylib', '/usr/lib/libstorm.so'].find(existsSync)

test.skipIf(!library)('extracts the winning MPQ file and honors a later delete marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'client-mpq-'))
  try {
    const data = join(root, 'Data')
    mkdirSync(join(data, 'enGB'), { recursive: true })
    const paths = ['common.MPQ', 'common-2.MPQ', 'expansion.MPQ', 'lichking.MPQ',
      'enGB/locale-enGB.MPQ', 'enGB/expansion-locale-enGB.MPQ', 'enGB/lichking-locale-enGB.MPQ',
      'patch.MPQ', 'patch-2.MPQ', 'patch-3.MPQ', 'enGB/patch-enGB.MPQ',
      'enGB/patch-enGB-2.MPQ', 'enGB/patch-enGB-3.MPQ']
    for (const [index, path] of paths.entries()) {
      const fixture = spawnSync('python3', ['tests/fixture-mpq.py', library!, join(data, path), index < 7 ? 'base' : 'patch'], { encoding: 'utf8' })
      expect(fixture.status, fixture.stderr).toBe(0)
    }
    const executable = join(root, 'Wow_Original.exe')
    const binary = spawnSync('python3', ['tests/fixture-pe.py', executable], { encoding: 'utf8' })
    expect(binary.status, binary.stderr).toBe(0)
    const exe = readFileSync(executable)
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    const script = readFileSync('extract-client.py', 'utf8')
      .replace('aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8', hash(exe))
      .replace('686dcc93b174144265d885ffdd28cf73c64afd64a550170aa995accb39f60493', hash('dbfilesclient/test.dbc\n'))
      .replace('EXPECTED_GLOBAL_CALLS = 73', 'EXPECTED_GLOBAL_CALLS = 2')
      .replace('EXPECTED_METHOD_CALLS = 39', 'EXPECTED_METHOD_CALLS = 1')
    const command = join(root, 'extract.py')
    writeFileSync(command, script)
    const out = join(root, 'output')
    const result = spawnSync('python3', [command, root, out, library!], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(readFileSync(join(out, 'DBFilesClient', 'Test.dbc'), 'utf8')).toBe('new')
    expect(existsSync(join(out, 'Interface', 'FrameXML', 'Remove.lua'))).toBe(false)
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    expect(manifest.files).toContainEqual({ path: 'DBFilesClient/Test.dbc', archive: 'enGB/patch-enGB-3.MPQ', sha256: hash('new') })
    const dump = JSON.parse(readFileSync(join(out, 'native-registrations.json'), 'utf8'))
    expect(manifest.files).toContainEqual({ path: 'native-registrations.json', executable: 'Wow_Original.exe', sha256: hash(readFileSync(join(out, 'native-registrations.json'))) })
    expect(dump.registrations.map(({ name, va, context, table }: { name: string, va: string, context: string, table: string }) => ({ name, va, context, table }))).toEqual([
      { name: 'Shared', va: '0x00420000', context: 'game', table: '0x00AB6000' },
      { name: 'Shared', va: '0x00420000', context: 'glue', table: '0x00AB6000' },
      { name: 'GameOnly', va: '0x00420010', context: 'game', table: '0x00AB6008' },
      { name: 'WidgetMethod', va: '0x00420020', context: 'game', table: '0x00AB6010' },
      { name: 'WidgetMethod', va: '0x00420020', context: 'glue', table: '0x00AB6010' },
    ])
    expect(existsSync(join(out, 'Wow_Original.exe'))).toBe(false)
    const broken = Buffer.from(exe)
    broken.writeUInt32LE(0xdeadbeef, 0x5df400)
    writeFileSync(executable, broken)
    writeFileSync(command, script.replace(hash(exe), hash(broken)))
    const rejectedOutput = join(root, 'rejected')
    const rejected = spawnSync('python3', [command, root, rejectedOutput, library!], { encoding: 'utf8' })
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('address outside one file-backed PE section')
    expect(existsSync(rejectedOutput)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
