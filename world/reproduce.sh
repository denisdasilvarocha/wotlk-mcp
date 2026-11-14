#!/bin/sh
set -eu

if [ "$#" -ne 2 ] && [ "$#" -ne 3 ]; then
  echo 'usage: sh world/reproduce.sh <pinned-source.tar.gz> <new-output-directory> [owned-resource-name]' >&2
  exit 2
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
archive=$(CDPATH= cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")
output=$2
expected=748a228d62fb2bf7203a193a4b622e3299fb78a3537ae1a150eda9091c1cf7f9
actual=$(openssl dgst -sha256 "$archive" | awk '{print $NF}')
if [ "$actual" != "$expected" ]; then
  echo 'AzerothCore source archive SHA-256 mismatch' >&2
  exit 1
fi
mkdir "$output"
patch_hash=$(openssl dgst -sha256 "$root/dbimport-build.patch" | awk '{print $NF}')
if [ "$patch_hash" != f6b3c5c896d67271b53fc5c98896d12d2f188ead9e66007da6d2ed067a5d2eb9 ]; then
  echo 'dbimport build patch SHA-256 mismatch' >&2
  exit 1
fi
output=$(CDPATH= cd -- "$output" && pwd)
tmp=$(mktemp -d)
name=${3:-wotlk-world-$(basename "$tmp" | tr -cd '[:alnum:]')}
case "$name" in
  wotlk-world-*) suffix=${name#wotlk-world-} ;;
  *) echo 'Invalid World Data resource name' >&2; rm -rf "$tmp"; exit 1 ;;
esac
case "$suffix" in
  ''|*[!a-zA-Z0-9]*) echo 'Invalid World Data resource name' >&2; rm -rf "$tmp"; exit 1 ;;
esac
keep=0
cleanup() {
  if [ "$keep" = 0 ]; then
    docker rm -f "$name" >/dev/null 2>&1 || :
    docker network rm "$name" >/dev/null 2>&1 || :
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM
mkdir "$tmp/source" "$tmp/build"
tar -xzf "$archive" -C "$tmp/source" --strip-components=1
if find "$tmp/source/data/sql/custom" "$tmp/source/modules" -name '*.sql' -print | grep -q .; then
  echo 'custom or module SQL is not allowed' >&2
  exit 1
fi
patch -d "$tmp/source" -p1 < "$root/dbimport-build.patch"
docker build --platform linux/arm64 -t wotlk-world-build-34 -f "$root/Dockerfile" "$root"
docker run --rm --platform linux/arm64 -v "$tmp/source:/src" -v "$tmp/build:/build" -w /build wotlk-world-build-34 sh -c 'cmake /src -G Ninja -DAPPS_BUILD=none -DTOOLS_BUILD=db-only -DSCRIPTS=none -DMODULES=none -DUSE_COREPCH=0 -DWITHOUT_GIT=1 -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="-DAC_MODULES_LIST=\\\"\\\"" && cmake --build . --target dbimport -j 4'
docker network create "$name" >/dev/null
docker run -d --name "$name" --network "$name" --platform linux/amd64 -e MYSQL_ROOT_PASSWORD=local-proof-only mysql@sha256:106d5197fd8e4892980469ad42eb20f7a336bd81509aae4ee175d852f5cc4565 --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci --default-time-zone=+00:00 --sql-mode=ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION >/dev/null
ready=0
for n in $(seq 1 120); do
  if docker exec -e MYSQL_PWD=local-proof-only "$name" mysql -uroot --batch --skip-column-names -e 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo 'MySQL did not become ready' >&2; exit 1; fi
docker exec -e MYSQL_PWD=local-proof-only "$name" mysql -uroot -e "CREATE USER 'proof'@'%' IDENTIFIED BY 'local-proof-only'; GRANT ALL PRIVILEGES ON *.* TO 'proof'@'%';"
docker run --rm --platform linux/arm64 --network "$name" -v "$tmp/source:/src:ro" -v "$tmp/build:/build:ro" -e AC_DISABLE_INTERACTIVE=1 -e "AC_LOGIN_DATABASE_INFO=$name;3306;proof;local-proof-only;acore_auth" -e "AC_WORLD_DATABASE_INFO=$name;3306;proof;local-proof-only;acore_world" -e "AC_CHARACTER_DATABASE_INFO=$name;3306;proof;local-proof-only;acore_characters" -e AC_UPDATES_ALLOWED_MODULES= wotlk-world-build-34 /build/src/tools/dbimport -c /src/src/tools/dbimport/dbimport.conf.dist > "$output/updater.log" 2>&1
for part in columns indexes; do
  docker exec -i -e MYSQL_PWD=local-proof-only "$name" mysql -uroot --batch --raw --skip-column-names < "$root/$part.sql" > "$output/schema-$part.tsv"
  if ! cmp "$root/schema-$part.tsv" "$output/schema-$part.tsv"; then
    echo "World Data schema $part drifted" >&2
    exit 1
  fi
done
{
  printf 'source_commit=2948c203faa0d23c4772441119ebe98e5b7cad95\nsource_sha256=%s\nbuild_patch_sha256=%s\n' "$actual" "$patch_hash"
  printf 'mysql=mysql@sha256:106d5197fd8e4892980469ad42eb20f7a336bd81509aae4ee175d852f5cc4565\nmysql_platform=linux/amd64\nbuild_platform=linux/arm64\nubuntu_snapshot=20261114T000000Z\n'
  printf 'container=%s\nnetwork=%s\n' "$name" "$name"
  docker exec -e MYSQL_PWD=local-proof-only "$name" mysql -uroot --batch --skip-column-names -e "SELECT VERSION(),@@global.sql_mode,@@global.time_zone,@@global.character_set_server,@@global.collation_server"
  openssl dgst -sha256 "$output/schema-columns.tsv" "$output/schema-indexes.tsv" "$output/updater.log"
} > "$output/report.txt"
keep=1
printf 'World Data ready in container %s; report: %s/report.txt\n' "$name" "$output"
