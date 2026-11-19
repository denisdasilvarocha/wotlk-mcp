import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vite-plus/test'

const verifier = fileURLToPath(
  new URL('../../build/sources/verify-client-inputs.py', import.meta.url)
)

const fixture = `
import hashlib
import io
import json
from pathlib import Path
import runpy
import sys
import tarfile
import tempfile


def sha256(data):
    return hashlib.sha256(data).hexdigest()


verify = runpy.run_path(sys.argv[1])['verify']
pins = verify.__globals__
name = 'DBFilesClient/Item.dbc'
content = b'fixture DBC'
manifest = json.dumps({
    'client': {'original_executable_sha256': pins['FINGERPRINT'], 'locale': 'enGB'},
    'files': [{'path': name, 'sha256': sha256(content)}],
    'inventory': {'paths_sha256': sha256((name.lower() + '\\n').encode())},
}).encode()

with tempfile.TemporaryDirectory() as directory:
    bundle = Path(directory) / 'bundle.tar.gz'
    with tarfile.open(bundle, 'w:gz') as archive:
        for path, data in [(sys.argv[2] + name, content), ('manifest.json', manifest)]:
            member = tarfile.TarInfo(path)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    pins['MANIFEST'] = Path(directory) / 'manifest.json'
    pins['MANIFEST'].write_bytes(manifest)
    pins['MANIFEST_SHA256'] = sha256(manifest)
    pins['BUNDLE_SHA256'] = sha256(bundle.read_bytes())
    verify(bundle)
`

test('verifies a bundle with one leading dot-slash on an archive member', () => {
  const result = spawnSync('python3', ['-B', '-c', fixture, verifier, './'], { encoding: 'utf8' })

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('verified 1 client files and manifest')
})

test('rejects additional dot path components rather than stripping them', () => {
  const result = spawnSync('python3', ['-B', '-c', fixture, verifier, '././'], { encoding: 'utf8' })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('unsafe archive path: ./DBFilesClient/Item.dbc')
})
