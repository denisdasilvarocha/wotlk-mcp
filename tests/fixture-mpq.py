import ctypes as C
import sys

lib = C.CDLL(sys.argv[1])
H = C.c_void_p
for name, args in [
    ('SFileCreateArchive', [C.c_char_p, C.c_uint32, C.c_uint32, C.POINTER(H)]),
    ('SFileCreateFile', [H, C.c_char_p, C.c_uint64, C.c_uint32, C.c_uint32, C.c_uint32, C.POINTER(H)]),
    ('SFileWriteFile', [H, C.c_void_p, C.c_uint32, C.c_uint32]),
    ('SFileFinishFile', [H]),
    ('SFileCloseArchive', [H]),
]:
    fn = getattr(lib, name)
    fn.argtypes = args
    fn.restype = C.c_bool

archive = H()
assert lib.SFileCreateArchive(sys.argv[2].encode(), 0, 16, C.byref(archive))
patch = sys.argv[3] == 'patch'
for name, data, flags in [
    (b'DBFilesClient\\Test.dbc', b'new' if patch else b'base', 0),
    (b'Interface\\FrameXML\\Remove.lua', b'' if patch else b'delete me', 0x02000000 if patch else 0),
]:
    file = H()
    assert lib.SFileCreateFile(archive, name, 0, len(data), 0, flags, C.byref(file))
    if data:
        assert lib.SFileWriteFile(file, data, len(data), 0)
    assert lib.SFileFinishFile(file)
assert lib.SFileCloseArchive(archive)
