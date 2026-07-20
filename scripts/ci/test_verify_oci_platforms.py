from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify-oci-platforms.py")


class VerifyOCIPlatformsTest(unittest.TestCase):
    def create_archive(self, platforms: list[tuple[str, str]], *, nested: bool = False) -> Path:
        temporary = tempfile.NamedTemporaryFile(suffix=".tar", delete=False)
        temporary.close()
        archive = Path(temporary.name)
        platform_index = {
            "schemaVersion": 2,
            "manifests": [
                {"mediaType": "application/vnd.oci.image.manifest.v1+json", "platform": {"os": os_name, "architecture": architecture}}
                for os_name, architecture in platforms
            ],
        }
        documents = {"index.json": json.dumps(platform_index).encode()}
        if nested:
            nested_payload = documents["index.json"]
            digest = hashlib.sha256(nested_payload).hexdigest()
            documents = {
                "index.json": json.dumps({
                    "schemaVersion": 2,
                    "manifests": [{
                        "mediaType": "application/vnd.oci.image.index.v1+json",
                        "digest": f"sha256:{digest}",
                        "size": len(nested_payload),
                    }],
                }).encode(),
                f"blobs/sha256/{digest}": nested_payload,
            }
        with tarfile.open(archive, "w") as bundle:
            for name, payload in documents.items():
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                bundle.addfile(member, io.BytesIO(payload))
        self.addCleanup(archive.unlink, missing_ok=True)
        return archive

    def run_verifier(self, archive: Path, *platforms: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(archive), *platforms],
            check=False,
            capture_output=True,
            text=True,
        )

    def test_accepts_an_archive_with_every_required_platform(self) -> None:
        archive = self.create_archive([("linux", "amd64"), ("linux", "arm64")], nested=True)
        result = self.run_verifier(archive, "linux/amd64", "linux/arm64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("linux/amd64, linux/arm64", result.stdout)

    def test_reports_missing_platforms(self) -> None:
        archive = self.create_archive([("linux", "amd64")])
        result = self.run_verifier(archive, "linux/amd64", "linux/arm64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("linux/arm64", result.stderr)


if __name__ == "__main__":
    unittest.main()
