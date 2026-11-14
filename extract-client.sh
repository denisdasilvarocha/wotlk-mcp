#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo 'usage: ./extract-client.sh CLIENT_ROOT OUTPUT_DIR' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
git clone --quiet https://github.com/ladislav-zezula/StormLib.git "$work/stormlib"
git -C "$work/stormlib" checkout --quiet --detach 6bb1882bd00ddbc3729cac5dac0fda81a61e5514
cmake -S "$work/stormlib" -B "$work/build" -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release >&2
cmake --build "$work/build" --parallel >&2
export STORMLIB_BUILD_CXX
STORMLIB_BUILD_CXX=$(awk -F= '$1 == "CMAKE_CXX_COMPILER:FILEPATH" {print $2}' "$work/build/CMakeCache.txt")
case $(uname -s) in
  Darwin) library="$work/build/storm.framework/storm";;
  Linux) library="$work/build/libstorm.so";;
  *) echo 'unsupported build host' >&2; exit 1;;
esac
python3 "$script_dir/extract-client.py" "$1" "$2" "$library"
