#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

if command -v npm >/dev/null 2>&1; then
    if [ ! -x node_modules/.bin/electron-builder ]; then
        npm ci
    fi
    exec npm run windows:pack
fi

container_command='npm ci && npm run windows:pack'
builder_image='docker.io/electronuserland/builder:wine'

if command -v podman >/dev/null 2>&1; then
    exec podman run --rm --userns=keep-id --security-opt label=disable \
        -e HOME=/tmp/siren-builder \
        -e ELECTRON_CACHE=/tmp/siren-builder/.cache/electron \
        -e ELECTRON_BUILDER_CACHE=/tmp/siren-builder/.cache/electron-builder \
        -v "$project_dir:/project" -w /project \
        "$builder_image" /bin/bash -lc "$container_command"
fi

if command -v docker >/dev/null 2>&1; then
    exec docker run --rm --user "$(id -u):$(id -g)" \
        -e HOME=/tmp/siren-builder \
        -e ELECTRON_CACHE=/tmp/siren-builder/.cache/electron \
        -e ELECTRON_BUILDER_CACHE=/tmp/siren-builder/.cache/electron-builder \
        -v "$project_dir:/project" -w /project \
        "$builder_image" /bin/bash -lc "$container_command"
fi

printf 'Install npm, Podman, or Docker to build the Windows executable.\n' >&2
exit 1
