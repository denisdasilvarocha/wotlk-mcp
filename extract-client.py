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
import struct
import tempfile

FINGERPRINT = 'aa63a5750d60ef16746c686b3d5e26876d98953eab08b1c026cd0faf78e88cb8'
LAA = '8d1067f7d3391248fee97fd7426fd86ac4ef9b88c06bce1b3e65f85c75112ede'
STORM_REVISION = '6bb1882bd00ddbc3729cac5dac0fda81a61e5514'
ORDER = ['common.MPQ', 'common-2.MPQ', 'expansion.MPQ', 'lichking.MPQ',
         'enGB/locale-enGB.MPQ', 'enGB/expansion-locale-enGB.MPQ', 'enGB/lichking-locale-enGB.MPQ',
         'patch.MPQ', 'patch-2.MPQ', 'patch-3.MPQ', 'enGB/patch-enGB.MPQ',
         'enGB/patch-enGB-2.MPQ', 'enGB/patch-enGB-3.MPQ']
EXPECTED_GLOBAL_CALLS = 73
EXPECTED_METHOD_CALLS = 39


def native_registrations(path, fingerprint, expected_global_calls, expected_method_calls):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != fingerprint:
        raise ValueError('native registration extraction: executable changed after fingerprint verification')

    def require(condition, message):
        if not condition:
            raise ValueError('native registration extraction: ' + message)

    def u16(offset):
        require(0 <= offset <= len(data) - 2, 'truncated PE header')
        return struct.unpack_from('<H', data, offset)[0]

    def u32(offset):
        require(0 <= offset <= len(data) - 4, 'truncated PE data')
        return struct.unpack_from('<I', data, offset)[0]

    require(data[:2] == b'MZ', 'missing DOS signature')
    pe = u32(0x3c)
    require(data[pe:pe + 4] == b'PE\0\0' and u16(pe + 4) == 0x14c, 'expected Windows x86 PE')
    count, optional_size = u16(pe + 6), u16(pe + 20)
    optional = pe + 24
    require(optional_size >= 96 and u16(optional) == 0x10b, 'expected PE32 optional header')
    base = u32(optional + 28)
    require(base == 0x400000, 'unexpected preferred image base')
    sections = []
    for index in range(count):
        off = optional + optional_size + index * 40
        require(off + 40 <= len(data), 'truncated section table')
        name = data[off:off + 8].rstrip(b'\0').decode('ascii')
        size, rva, raw_size, raw = struct.unpack_from('<4I', data, off + 8)
        require(raw + raw_size <= len(data), 'section exceeds file')
        sections.append((name, base + rva, min(size, raw_size), raw))

    def offset(va, size=1):
        matches = [raw + va - start for _, start, length, raw in sections
                   if start <= va and va + size <= start + length]
        require(len(matches) == 1, 'address outside one file-backed PE section: ' + hex(va))
        return matches[0]

    def read(va, size):
        off = offset(va, size)
        return data[off:off + size]

    def word(va):
        return u32(offset(va, 4))

    def string(va):
        off = offset(va)
        section = next((s for s in sections if s[1] <= va < s[1] + s[2]), None)
        end = data.find(b'\0', off, section[3] + section[2])
        require(end > off, 'unterminated registration name at ' + hex(va))
        name = data[off:end].decode('ascii')
        require(re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', name) is not None, 'invalid registration name')
        return name

    def va(value):
        return f'0x{value:08X}'

    text = next((s for s in sections if s[0] == '.text'), None)
    require(text is not None, 'missing .text')
    text_start, text_size, text_raw = text[1:]
    code = data[text_raw:text_raw + text_size]

    def calls(target):
        result = []
        for i in range(len(code) - 4):
            if code[i] == 0xe8 and text_start + i + 5 + struct.unpack_from('<i', code, i + 1)[0] == target:
                result.append(text_start + i)
        return result

    global_calls, method_calls = calls(0x817f90), calls(0x8167e0)
    require(len(global_calls) == expected_global_calls and len(method_calls) == expected_method_calls,
            f'unexpected registrar call counts: {len(global_calls)} globals, {len(method_calls)} methods')

    def direct_targets(start, end):
        block = read(start, end - start)
        result = set()
        for i in range(len(block) - 4):
            if block[i] in (0xe8, 0xe9):
                target = start + i + 5 + struct.unpack_from('<i', block, i + 1)[0]
                if text_start <= target < text_start + text_size:
                    result.add(target)
        return result

    # These fingerprint-bound dispatch ranges are the glue, game and shared initializers.
    glue = direct_targets(0x4da71c, 0x4da749)
    game = direct_targets(0x5120e0, 0x512272) | {0x5120e0}
    shared = direct_targets(0x81b870, 0x81b914) | {0x81b870}
    require(0x81b870 in glue and 0x81b870 in game, 'shared widget dispatch is not reached by both roots')
    roots = {'glue': glue | shared, 'game': game | shared}
    records = {}

    def add(kind, table, index, name, handler, context, site):
        require(text_start <= handler < text_start + text_size, 'handler outside .text: ' + hex(handler))
        key = (table, index, context, kind)
        row = records.setdefault(key, {'kind': kind, 'name': name, 'va': va(handler), 'context': context,
                                       'table': va(table), 'index': index, 'call_sites': []})
        require(row['name'] == name and row['va'] == va(handler), 'conflicting table row')
        if va(site) not in row['call_sites']:
            row['call_sites'].append(va(site))

    def table_rows(kind, table, count, context, site):
        require(0 < count <= 4096, 'invalid registration table count')
        offset(table, count * 8)
        for index in range(count):
            name_ptr, handler = struct.unpack_from('<II', data, offset(table + index * 8, 8))
            add(kind, table, index, string(name_ptr), handler, context, site)

    for site in global_calls:
        before = read(site - 14, 14)
        if before[:2] in (b'\x8b\x86', b'\x8b\x96') and before[6:8] in (b'\x8b\x8e', b'\x8b\x86'):
            handler_table, table = struct.unpack_from('<I', before, 2)[0], struct.unpack_from('<I', before, 8)[0]
            require(handler_table == table + 4 and before[12:] in (b'\x50\x51', b'\x52\x50'),
                    'unrecognized global registration operands at ' + hex(site))
            after = read(site + 5, 16)
            require(after[:6] == b'\x83\xc6\x08\x83\xc4\x08', 'unrecognized global loop')
            if after[6:8] == b'\x81\xfe':
                length = struct.unpack_from('<I', after, 8)[0]
            elif after[6:8] == b'\x83\xfe':
                length = after[8]
            else:
                raise ValueError('native registration extraction: unrecognized global loop count at ' + hex(site))
            require(length % 8 == 0, 'unaligned global table count')
            count = length // 8
        elif before[1:2] == b'\xa1' and before[6:8] == b'\x8b\x0d' and before[12:] == b'\x50\x51':
            handler_table, table = struct.unpack_from('<I', before, 2)[0], struct.unpack_from('<I', before, 8)[0]
            require(handler_table == table + 4, 'invalid singleton table')
            count = 1
        else:
            raise ValueError('native registration extraction: unrecognized global call at ' + hex(site))
        candidates = [target for targets in roots.values() for target in targets if target <= site < target + 0x100]
        require(candidates, 'global call has no dispatch context: ' + hex(site))
        owner = max(candidates)
        contexts = [context for context, targets in roots.items() if owner in targets]
        for context in contexts:
            table_rows('global', table, count, context, site)

    callbacks = {}
    for site in method_calls:
        off = offset(site)
        start = data.rfind(b'\x55\x8b\xec', max(text_raw, off - 150), off)
        require(start >= text_raw, 'method callback prologue not found: ' + hex(site))
        callback = text_start + start - text_raw
        args = read(site - 8, 8)
        require(args[0] == 0x6a and args[2] == 0x68 and args[7] in (0x50, 0x56),
                'unrecognized method call at ' + hex(site))
        table = struct.unpack_from('<I', args, 3)[0]
        callbacks.setdefault(callback, []).append((table, args[1], site))

    contexts = {callback: set() for callback in callbacks}
    for callback in callbacks:
        pattern = b'\x68' + struct.pack('<I', callback) + b'\x50\xe8'
        start = 0
        while (index := code.find(pattern, start)) != -1:
            initializer = text_start + index - 5
            if code[index - 5] == 0xe8:
                target = text_start + index + 11 + struct.unpack_from('<i', code, index + 7)[0]
                if target == 0x816790:
                    for context, targets in roots.items():
                        if initializer in targets:
                            contexts[callback].add(context)
            start = index + 1

    # Widget callbacks invoke their parent's callback before registering their own table.
    changed = True
    while changed:
        changed = False
        for callback, rows in callbacks.items():
            end = min(site for _, _, site in rows)
            for parent in direct_targets(callback, end):
                if parent in contexts:
                    old = len(contexts[parent])
                    contexts[parent].update(contexts[callback])
                    changed |= len(contexts[parent]) != old
    for callback, rows in callbacks.items():
        require(contexts[callback], 'method callback has no dispatch context: ' + hex(callback))
        for table, count, site in rows:
            for context in sorted(contexts[callback]):
                table_rows('method', table, count, context, site)
    result = [records[key] for key in sorted(records)]
    for row in result:
        row['call_sites'].sort()
    return {'format': 1, 'executable_sha256': fingerprint, 'image_base': va(base),
            'extraction': {'global_registrar': va(0x817f90), 'method_iterator': va(0x8167e0),
                           'glue_dispatch_range': [va(0x4da71c), va(0x4da749)],
                           'game_dispatch_range': [va(0x5120e0), va(0x512272)],
                           'shared_dispatch_range': [va(0x81b870), va(0x81b914)]},
            'registrations': result}


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
    extract(root, output, library, fingerprint,
            '686dcc93b174144265d885ffdd28cf73c64afd64a550170aa995accb39f60493',
            EXPECTED_GLOBAL_CALLS, EXPECTED_METHOD_CALLS)


def extract(root, output, library, fingerprint, expected_inventory, expected_global_calls, expected_method_calls):
    if output.exists():
        raise ValueError('output must not already exist: ' + str(output))
    native = native_registrations(root / 'Wow_Original.exe', fingerprint, expected_global_calls, expected_method_calls)
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
        if inventory_hash != expected_inventory:
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
            registration_dump = dest / 'native-registrations.json'
            registration_dump.write_text(json.dumps(native, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')
            files.append({'path': registration_dump.name, 'executable': 'Wow_Original.exe',
                          'sha256': sha(registration_dump)})
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
