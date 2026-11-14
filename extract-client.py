#!/usr/bin/env python3
"""Extract the trusted enGB client with a locally built StormLib 9.40."""
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import subprocess
import tempfile

FINGERPRINT = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
LAA = '8d1067f7d3391248fee97fd7426fd86ac4ef9b88c06bce1b3e65f85c75112ede'
STORM_REVISION = '6bb1882bd00ddbc3729cac5dac0fda81a61e5514'
ORDER = ['common.MPQ', 'common-2.MPQ', 'expansion.MPQ', 'lichking.MPQ',
         'enGB/locale-enGB.MPQ', 'enGB/expansion-locale-enGB.MPQ', 'enGB/lichking-locale-enGB.MPQ',
         'patch.MPQ', 'patch-2.MPQ', 'patch-3.MPQ', 'enGB/patch-enGB.MPQ',
         'enGB/patch-enGB-2.MPQ', 'enGB/patch-enGB-3.MPQ']


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


class FindData(C.Structure):
    _fields_ = [('name', C.c_char * 1024), ('plain', C.c_void_p), ('hash_index', C.c_uint32),
                ('block_index', C.c_uint32), ('size', C.c_uint32), ('flags', C.c_uint32),
                ('compressed_size', C.c_uint32), ('time_lo', C.c_uint32), ('time_hi', C.c_uint32),
                ('locale', C.c_uint32)]


def eligible(path):
    p = path.lower()
    return (p.startswith('dbfilesclient/') and p.endswith('.dbc') or
            re.match(r'^interface/(?:framexml|gluexml|addons/blizzard_[^/]+)/', p) is not None
            and p.endswith(('.lua', '.xml', '.toc')))


def main():
    if len(sys.argv) != 4:
        raise ValueError('usage: python3 extract-client.py CLIENT_ROOT OUTPUT_DIR STORMLIB_LIBRARY')
    root, output, library = map(Path, sys.argv[1:])
    fingerprint = sha(root / 'Wow_Original.exe')
    if fingerprint != FINGERPRINT:
        if fingerprint == LAA:
            raise ValueError('Wow_Original.exe is the installed large-address-aware variant, not the trusted original')
        raise ValueError('Wow_Original.exe fingerprint mismatch: ' + fingerprint)
    if output.exists():
        raise ValueError('output must not already exist: ' + str(output))
    lib = C.CDLL(str(library.resolve()))
    H = C.c_void_p
    lib.SFileOpenPatchArchive.argtypes = [H, C.c_char_p, C.c_char_p, C.c_uint32]
    lib.SFileOpenPatchArchive.restype = C.c_bool
    lib.SFileOpenArchive.argtypes = [C.c_char_p, C.c_uint32, C.c_uint32, C.POINTER(H)]
    lib.SFileOpenArchive.restype = C.c_bool
    lib.SFileFindFirstFile.argtypes = [H, C.c_char_p, C.POINTER(FindData), C.c_char_p]
    lib.SFileFindFirstFile.restype = H
    lib.SFileFindNextFile.argtypes = [H, C.POINTER(FindData)]
    lib.SFileFindNextFile.restype = C.c_bool
    lib.SFileFindClose.argtypes = [H]
    lib.SFileCloseArchive.argtypes = [H]
    lib.SFileExtractFile.argtypes = [H, C.c_char_p, C.c_char_p, C.c_uint32]
    lib.SFileExtractFile.restype = C.c_bool
    handles, winners, archives = {}, {}, []
    try:
        for name in ORDER:
            path = root / 'Data' / name
            digest = sha(path)
            handle = H()
            if not lib.SFileOpenArchive(os.fsencode(path), 0, 0x100, C.byref(handle)):
                raise ValueError('cannot open archive: ' + str(path))
            handles[name] = handle
            archives.append({'path': name, 'sha256': digest})
            data = FindData()
            find = lib.SFileFindFirstFile(handle, b'*', C.byref(data), None)
            if not find:
                raise ValueError('archive enumeration failed or archive is empty: ' + name)
            seen = set()
            try:
                while True:
                    raw = data.name.decode('utf-8')
                    path = raw.replace('\\', '/')
                    if eligible(path):
                        if any(part in ('', '.', '..') for part in path.split('/')) or ':' in path:
                            raise ValueError('unsafe archive path: ' + path)
                        key = path.lower()
                        if key in seen:
                            raise ValueError('conflicting archive entries: ' + name + ': ' + path)
                        seen.add(key)
                        if data.flags & 0x02000000:
                            winners.pop(key, None)
                        elif data.flags & 0x00100000:
                            if key not in winners:
                                raise ValueError('incremental patch has no base: ' + name + ': ' + path)
                            winners[key].append((name, raw, path))
                        else:
                            winners[key] = [(name, raw, path)]
                    if not lib.SFileFindNextFile(find, C.byref(data)):
                        break
            finally:
                lib.SFileFindClose(find)
        inventory_hash = hashlib.sha256((''.join(key + '\n' for key in sorted(winners))).encode()).hexdigest()
        if inventory_hash != '686dcc93b174144265d885ffdd28cf73c64afd64a550170aa995accb39f60493':
            raise ValueError('client input paths do not match the trusted research inventory: ' + inventory_hash)
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.client-inputs-', dir=output.parent) as tmp:
            dest = Path(tmp) / 'inputs'
            dest.mkdir()
            files = []
            for key in sorted(winners):
                chain = winners[key]
                archive, raw, relative = chain[-1]
                target = dest.joinpath(*relative.split('/'))
                target.parent.mkdir(parents=True, exist_ok=True)
                handle = handles[archive]
                temporary_handle = H()
                if len(chain) > 1:
                    if not lib.SFileOpenArchive(os.fsencode(root / 'Data' / chain[0][0]), 0, 0x100, C.byref(temporary_handle)):
                        raise ValueError('cannot reopen base archive: ' + chain[0][0])
                    handle = temporary_handle
                try:
                    for patch, _, _ in chain[1:]:
                        if not lib.SFileOpenPatchArchive(handle, os.fsencode(root / 'Data' / patch), b'', 0):
                            raise ValueError('cannot attach incremental patch: ' + patch)
                    if not lib.SFileExtractFile(handle, raw.encode('utf-8'), os.fsencode(target), 0):
                        raise ValueError('extraction failed: ' + archive + ': ' + relative)
                finally:
                    if temporary_handle:
                        lib.SFileCloseArchive(temporary_handle)
                files.append({'path': relative, 'archive': archive, 'sha256': sha(target)})
            manifest = {'format': 1, 'client': {'build': 12340, 'locale': 'enGB',
                        'provenance': 'English stand-in for enUS; byte identity is not verified',
                        'original_executable_sha256': fingerprint},
                        'extractor': {'stormlib_revision': STORM_REVISION,
                                      'library_sha256': sha(library), 'python': platform.python_version(),
                                      'platform': platform.platform(),
                                      'cmake': subprocess.check_output(['cmake', '--version'], text=True).splitlines()[0],
                                      'compiler': subprocess.check_output([os.environ.get('STORMLIB_BUILD_CXX', 'c++'), '--version'], text=True).splitlines()[0]},
                        'inventory': {'paths_sha256': inventory_hash,
                                      'research_commit': '6aaec0a94f70848127c155aa627554e5e9cad3b6',
                                      'excluded': [{'path': 'Interface/LCDXML/LCDColorLayout.xml', 'reason': 'outside FrameXML, GlueXML and Blizzard addons'},
                                                   {'path': 'Interface/LCDXML/LCDLayout.xml', 'reason': 'outside FrameXML, GlueXML and Blizzard addons'}]},
                        'archives': archives, 'files': files}
            (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')
            os.rename(dest, output)
    finally:
        for handle in handles.values():
            lib.SFileCloseArchive(handle)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, UnicodeError) as error:
        print('client extraction: ' + str(error), file=sys.stderr)
        sys.exit(1)
