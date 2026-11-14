# vite-plus-starter

A starter for creating a Vite Plus project.

## Development

- Install dependencies:

```bash
vp install
```

- Run the unit tests:

```bash
vp test
```

- Build the library:

```bash
vp pack
```

## Extracting maintainer client inputs

On macOS or Linux, install Git, CMake, a C++ compiler and Python 3, then run:

```bash
./extract-client.sh /path/to/trusted-client /path/to/new-client-inputs
```

The client directory must contain `Wow_Original.exe` and the complete enGB
archive set under `Data`. The launcher builds StormLib at commit
`6bb1882bd00ddbc3729cac5dac0fda81a61e5514`. It verifies the original
executable SHA-256 before reading archives and rejects the installed
large-address-aware `Wow.exe` variant. The executable is never copied.

The output contains DBC files, FrameXML, GlueXML and Blizzard addon Lua, XML
and TOC files, plus `manifest.json` with archive and file SHA-256 hashes,
winning archives, extractor revision and library hash. Later archives win;
deletion markers remove earlier files. An output directory must not already
exist. The inventory uses enGB as the accepted English stand-in: enUS byte
identity has not been verified. Keep client-derived files private until the
owner performs the trusted-client production bundle and publication in #30;
the command's development fixtures do not replace that proof.

The selected path set is checked against the lowercase, sorted inventory from
fingerprint research commit `6aaec0a94f70848127c155aa627554e5e9cad3b6`.
The two `Interface/LCDXML` XML files observed in that research are outside
the specified Interface directories and are recorded as exclusions. The
manifest also records the actual library hash, compiler, CMake, Python and
host versions; these describe the build environment rather than claiming a
byte-identical compiler environment on every host.

The synthetic archive test uses a local StormLib shared library. Set
`STORMLIB_TEST_LIBRARY` to its absolute path if it is not installed at the
default macOS or Linux location.
