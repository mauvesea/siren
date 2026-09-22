#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

usage() {
    printf 'Usage: %s [all|appimage|deb|rpm]...\n' "$0"
    printf 'With no arguments, build all three package formats.\n'
}

if [ "${1:-}" = '--help' ] || [ "${1:-}" = '-h' ]; then
    usage
    exit 0
fi

if [ "$#" -eq 0 ]; then
    set -- all
fi

build_appimage=false
build_deb=false
build_rpm=false
for format in "$@"; do
    case "$format" in
        all) build_appimage=true; build_deb=true; build_rpm=true ;;
        appimage) build_appimage=true ;;
        deb) build_deb=true ;;
        rpm) build_rpm=true ;;
        *) usage >&2; exit 2 ;;
    esac
done

build_native_package() {
    format=$1
    case "$format" in
        deb) target="Siren-1.1.0-amd64.deb" ;;
        rpm) target="Siren-1.1.0-x86_64.rpm" ;;
    esac

    if command -v nfpm >/dev/null 2>&1; then
        nfpm package --config nfpm.yaml --packager "$format" --target "$target"
    elif command -v podman >/dev/null 2>&1; then
        podman run --rm --userns=keep-id --security-opt label=disable \
            -v "$project_dir:/build" -w /build \
            ghcr.io/goreleaser/nfpm:v2.47.0 \
            package --config nfpm.yaml --packager "$format" --target "$target"
    else
        printf 'Install nFPM or Podman to build %s packages.\n' "$format" >&2
        exit 1
    fi
}

if [ "$build_appimage" = true ]; then
    ./build-appimage.sh
fi
if [ "$build_deb" = true ]; then
    build_native_package deb
fi
if [ "$build_rpm" = true ]; then
    build_native_package rpm
fi
