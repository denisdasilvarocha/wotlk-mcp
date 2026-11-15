#!/usr/bin/env python3
"""Verify the pinned client-inputs asset without extracting its contents."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

BUNDLE_SHA256 = '9f57598199dd2e9b185c1f3e14f42ba59b10f11b30f2e672d3554cebbe191136'
FINGERPRINT = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
MANIFEST_SHA256 = 'e5db5940f6e7ca8b3862c5c27b1a08cdc45571d79bd2ba9607540a5e432f3235'
MANIFEST = Path(__file__).resolve().parent.parent / 'data/client-inputs/manifest.json'


def verify(path):
    with path.open('rb') as stream:
        if digest(stream) != BUNDLE_SHA256:
            raise ValueError('bundle SHA-256 mismatch')

    manifest_bytes = MANIFEST.read_bytes()

    if hashlib.sha256(manifest_bytes).hexdigest() != MANIFEST_SHA256:
        raise ValueError('committed manifest SHA-256 mismatch')

    manifest = json.loads(manifest_bytes)

    if manifest['client']['original_executable_sha256'] != FINGERPRINT or manifest['client']['locale'] != 'enGB':
        raise ValueError('unexpected client provenance')

    files = {entry['path']: entry['sha256'] for entry in manifest['files']}

    if len(files) != len(manifest['files']):
        raise ValueError('duplicate manifest path')

    allowed = re.compile(r'(?i)^(?:DBFilesClient/[^/]+\.dbc|Interface/(?:FrameXML|GlueXML|AddOns/Blizzard_[^/]+)/.+\.(?:lua|xml|toc))$')

    if any(name != 'native-registrations.json' and not allowed.fullmatch(name) for name in files):
        raise ValueError('out-of-scope manifest path')

    paths = sorted(name.lower() for name in files if name != 'native-registrations.json')

    if hashlib.sha256(''.join(name + '\n' for name in paths).encode()).hexdigest() != manifest['inventory']['paths_sha256']:
        raise ValueError('client inventory mismatch')

    expected = dict(files, **{'manifest.json': MANIFEST_SHA256})
    seen = set()
    directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents}

    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            name = member.name.removeprefix('./').rstrip('/') or '.'

            if name.startswith('/') or any(part in ('', '.', '..') for part in name.split('/')) and name != '.':
                raise ValueError('unsafe archive path: ' + name)
            if name in seen:
                raise ValueError('duplicate archive path: ' + name)

            seen.add(name)

            if member.isdir() and name in directories:
                continue
            if not member.isfile() or name not in expected:
                raise ValueError('unexpected archive member: ' + name)

            stream = archive.extractfile(member)

            if stream is None or digest(stream) != expected[name]:
                raise ValueError('file SHA-256 mismatch: ' + name)

        missing = expected.keys() - seen

        if missing:
            raise ValueError('missing archive files: ' + ', '.join(sorted(missing)))

    print(f'verified {len(files)} client files and manifest; bundle SHA-256 {BUNDLE_SHA256}')


def digest(stream):
    h = hashlib.sha256()

    for block in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(block)

    return h.hexdigest()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('usage: python3 build/verify-client-inputs.py CLIENT_INPUTS_TAR_GZ')

        verify(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
