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

- Validate the curated Offsets JSON and unique paths:

```bash
vp run validate:offsets
```

The 13 documents in `data/offsets` use the schema in `data/offsets.schema.json`. After changing the Zod schema in `src/offsets.ts`, regenerate it with `vpx scripts/validate-offsets.ts --schema > data/offsets.schema.json`. Topic names have no semantic significance; paths omit only `WoWOffsets::`. The migration test compares against the original C++ declarations preserved in `tests/fixtures/original-offsets.txt` from commit `34504ad`. See [address conventions](docs/offsets/address-conventions.md) and [Windows x86 provenance](docs/offsets/windows-x86.md) before using an entry.

- Build the library:

```bash
vp pack
```

## Reproduce World Data

Requires Docker with linux/arm64 and linux/amd64 support, `curl`, `openssl`, `patch`, and a POSIX shell. Download the pinned AzerothCore archive and provide a new output directory:

```bash
curl -fL https://codeload.github.com/azerothcore/azerothcore-wotlk/tar.gz/2948c203faa0d23c4772441119ebe98e5b7cad95 -o azerothcore.tar.gz
sh world/reproduce.sh azerothcore.tar.gz world-output
```

The command verifies the archive, builds the pinned upstream database importer, creates isolated fresh databases, applies upstream updates, and compares the selected World Data schema to the committed manifests. The output contains the importer log, observed schema, and a report; it does not publish data. On success the report names the running MySQL container and its private network for the export step. Remove both with `docker rm -f <container>` and `docker network rm <network>` when finished.

The build-only patch removes links to disabled scripts and modules; updater code is unchanged. Custom and module SQL are rejected. The local container uses disposable, known credentials and must not be exposed to an untrusted network.

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
