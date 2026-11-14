import struct
import sys
from pathlib import Path

# Synthetic PE32: virtual addresses and file offsets deliberately differ.
p = bytearray(0x5e0400)
def put(off, value):
    p[off:off + len(value)] = value
def u16(off, value):
    struct.pack_into('<H', p, off, value)
def u32(off, value):
    struct.pack_into('<I', p, off, value)
def at(va):
    if 0x401000 <= va < 0x9e1000:
        return 0x400 + va - 0x401000
    if 0xab6000 <= va < 0xab7000:
        return 0x5df400 + va - 0xab6000
    raise ValueError(hex(va))
def bytes_at(va, data):
    put(at(va), data)
def call(src, dst, opcode=0xe8):
    bytes_at(src, bytes([opcode]) + struct.pack('<i', dst - src - 5))

put(0, b'MZ'); u32(0x3c, 0x80); put(0x80, b'PE\0\0'); u16(0x84, 0x14c); u16(0x86, 2); u16(0x94, 0xe0)
u16(0x98, 0x10b); u32(0x98 + 28, 0x400000)
put(0x178, b'.text\0\0\0'); u32(0x180, 0x5e0000); u32(0x184, 0x1000); u32(0x188, 0x5df000); u32(0x18c, 0x400)
put(0x1a0, b'.data\0\0\0'); u32(0x1a8, 0x1000); u32(0x1ac, 0x6b6000); u32(0x1b0, 0x1000); u32(0x1b4, 0x5df400)

# Real dispatch ranges: glue, game and shared. Glue and game share one global.
call(0x4da71c, 0x410000); call(0x4da721, 0x81b870)
call(0x5120e0, 0x81b870); call(0x5120e5, 0x410000); call(0x5120ea, 0x410100)
call(0x81b870, 0x410200)
# Two loop registrations; names and handler VAs live in distinct PE sections.
def loop(start, table):
    bytes_at(start, b'\x56\x33\xf6\x8b\x86' + struct.pack('<I', table + 4) + b'\x8b\x8e' + struct.pack('<I', table) + b'\x50\x51')
    call(start + 17, 0x817f90)
    bytes_at(start + 22, b'\x83\xc6\x08\x83\xc4\x08\x83\xfe\x08\x72\xe2\x5e\xc3')
loop(0x410000, 0xab6000); loop(0x410100, 0xab6008)
# Widget initializer passes callback to 0x816790; callback has one method table.
call(0x410200, 0x817db0); bytes_at(0x410205, b'\x68' + struct.pack('<I', 0x410300) + b'\x50'); call(0x41020b, 0x816790); bytes_at(0x410210, b'\xc3')
bytes_at(0x410300, b'\x55\x8b\xec\x8b\x45\x08\x6a\x01\x68' + struct.pack('<I', 0xab6010) + b'\x50'); call(0x41030e, 0x8167e0); bytes_at(0x410313, b'\xc3')
for va, nameva, handler in [(0xab6000, 0xab6100, 0x420000), (0xab6008, 0xab6110, 0x420010), (0xab6010, 0xab6120, 0x420020)]:
    bytes_at(va, struct.pack('<II', nameva, handler))
bytes_at(0xab6100, b'Shared\0'); bytes_at(0xab6110, b'GameOnly\0'); bytes_at(0xab6120, b'WidgetMethod\0')
Path(sys.argv[1]).write_bytes(p)
