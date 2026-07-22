#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
catalog_file=$(mktemp)
trap 'rm -f "$catalog_file"' EXIT HUP INT TERM

command -v docker >/dev/null 2>&1 || {
  echo "docker is required to verify template images" >&2
  exit 1
}
docker buildx version >/dev/null

(cd "$repository_root/backend" && go run ./cmd/template-images) > "$catalog_file"

while IFS="$(printf '\t')" read -r image_reference architectures; do
  [ -n "$image_reference" ] || continue
  echo "verifying $image_reference ($architectures)"
  env DBMOCK_TEMPLATE_IMAGE="$image_reference" DBMOCK_TEMPLATE_ARCHITECTURES="$architectures" python3 -c '
import json
import os
import subprocess
import sys

reference = os.environ["DBMOCK_TEMPLATE_IMAGE"]
required = {item for item in os.environ["DBMOCK_TEMPLATE_ARCHITECTURES"].split(",") if item}

def inspect(*arguments):
    result = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", reference, *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise SystemExit(result.stderr.strip() or f"cannot inspect {reference}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"cannot inspect {reference}: {error}")

document = inspect("--raw")
available = {
    platform.get("architecture")
    for descriptor in document.get("manifests", [])
    if isinstance(descriptor, dict)
    for platform in [descriptor.get("platform")]
    if isinstance(platform, dict) and platform.get("os") == "linux"
}
if not available:
    image = inspect("--format", "{{json .Image}}")
    if image.get("os") == "linux" and image.get("architecture"):
        available.add(image["architecture"])
missing = required - available
if missing:
    found = ", ".join(sorted(item for item in available if item)) or "none"
    separator = ", "
    raise SystemExit(f"{reference} is missing linux platforms: {separator.join(sorted(missing))}; found: {found}")
'
done < "$catalog_file"

echo "all built-in template image tags and declared platforms are available"
