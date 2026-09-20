#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

if command -v appimage-builder >/dev/null 2>&1; then
    exec appimage-builder --recipe AppImageBuilder.yml --skip-test
fi

if command -v podman >/dev/null 2>&1; then
    exec podman run --rm --userns=keep-id --security-opt label=disable \
        -v "$project_dir:/build" -w /build \
        docker.io/appimagecrafters/appimage-builder:latest \
        appimage-builder --recipe AppImageBuilder.yml --skip-test
fi

printf 'Install appimage-builder or Podman to build the AppImage.\n' >&2
exit 1
