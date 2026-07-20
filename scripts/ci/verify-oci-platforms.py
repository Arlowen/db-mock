#!/usr/bin/env python3
"""Verify that an OCI archive contains every required operating system/architecture."""

from __future__ import annotations

import json
import sys
import tarfile
from pathlib import Path


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if len(sys.argv) < 3:
        fail(f"usage: {Path(sys.argv[0]).name} <archive.tar> <os/architecture> [...]")

    archive = Path(sys.argv[1])
    required = set(sys.argv[2:])
    if not archive.is_file():
        fail(f"OCI archive does not exist: {archive}")

    try:
        with tarfile.open(archive, "r") as bundle:
            members = {item.name.lstrip("./"): item for item in bundle.getmembers()}

            def load_document(name: str) -> dict[str, object]:
                member = members.get(name)
                if member is None:
                    fail(f"OCI archive is missing {name}")
                extracted = bundle.extractfile(member)
                if extracted is None:
                    fail(f"OCI archive member cannot be read: {name}")
                document = json.load(extracted)
                if not isinstance(document, dict):
                    fail(f"OCI archive member is not a JSON object: {name}")
                return document

            def descriptor_name(descriptor: dict[str, object]) -> str | None:
                digest = descriptor.get("digest")
                if not isinstance(digest, str) or ":" not in digest:
                    return None
                algorithm, value = digest.split(":", 1)
                return f"blobs/{algorithm}/{value}"

            available: set[str] = set()
            visited: set[str] = set()

            def visit(document: dict[str, object]) -> None:
                manifests = document.get("manifests")
                if not isinstance(manifests, list):
                    return
                for item in manifests:
                    if not isinstance(item, dict):
                        continue
                    platform = item.get("platform")
                    if isinstance(platform, dict) and platform.get("os") and platform.get("architecture"):
                        available.add(f"{platform['os']}/{platform['architecture']}")
                    nested_name = descriptor_name(item)
                    if nested_name and nested_name not in visited and "index" in str(item.get("mediaType", "")):
                        visited.add(nested_name)
                        visit(load_document(nested_name))

            visit(load_document("index.json"))
    except (OSError, tarfile.TarError, json.JSONDecodeError) as error:
        fail(f"cannot inspect OCI archive: {error}")

    missing = sorted(required - available)
    if missing:
        fail(f"OCI archive is missing required platforms: {', '.join(missing)}; found: {', '.join(sorted(available)) or 'none'}")
    print(f"verified OCI platforms: {', '.join(sorted(required))}")


if __name__ == "__main__":
    main()
