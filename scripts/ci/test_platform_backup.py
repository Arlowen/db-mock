from __future__ import annotations

import hashlib
import io
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RESTORE_SCRIPT = ROOT / "scripts" / "restore-platform.sh"


class PlatformBackupValidationTest(unittest.TestCase):
    def create_archive(
        self,
        *,
        format_version: str = "1",
        database_checksum: str | None = None,
        include_app_data: bool = True,
    ) -> Path:
        database = b"postgres-custom-dump-fixture"
        app_data = b"application-data-tar-fixture"
        manifest = (
            f"format={format_version}\n"
            f"created_at=20260722T000000Z\n"
            f"database_sha256={database_checksum or hashlib.sha256(database).hexdigest()}\n"
            f"app_data_sha256={hashlib.sha256(app_data).hexdigest()}\n"
        ).encode()
        temporary = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
        temporary.close()
        archive = Path(temporary.name)
        with tarfile.open(archive, "w:gz") as bundle:
            entries = {"manifest": manifest, "database.dump": database}
            if include_app_data:
                entries["app-data.tar"] = app_data
            for name, payload in entries.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o600
                member.size = len(payload)
                bundle.addfile(member, io.BytesIO(payload))
        self.addCleanup(archive.unlink, missing_ok=True)
        return archive

    def validate(
        self,
        archive: Path,
        *,
        confirm: bool = False,
        passphrase_file: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = {**os.environ, "DBMOCK_RESTORE_VALIDATE_ONLY": "true"}
        if confirm:
            environment["DBMOCK_RESTORE_CONFIRM"] = "RESTORE"
        if passphrase_file:
            environment["DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE"] = str(passphrase_file)
        return subprocess.run(
            [str(RESTORE_SCRIPT), str(archive)],
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
        )

    def test_accepts_a_complete_archive_with_matching_checksums(self) -> None:
        result = self.validate(self.create_archive())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Control-plane backup is valid", result.stdout)

    def test_rejects_a_database_checksum_mismatch_before_restore(self) -> None:
        result = self.validate(self.create_archive(database_checksum="0" * 64), confirm=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("database dump checksum does not match", result.stderr)

    def test_rejects_missing_required_data(self) -> None:
        result = self.validate(self.create_archive(include_app_data=False))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing required entry: app-data.tar", result.stderr)

    def test_rejects_unknown_format_versions(self) -> None:
        result = self.validate(self.create_archive(format_version="2"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unsupported control-plane backup format", result.stderr)

    def test_rejects_link_entries_without_following_them(self) -> None:
        temporary = tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False)
        temporary.close()
        archive = Path(temporary.name)
        with tarfile.open(archive, "w:gz") as bundle:
            manifest = tarfile.TarInfo("manifest")
            manifest.type = tarfile.SYMTYPE
            manifest.linkname = "/etc/passwd"
            bundle.addfile(manifest)
            for name, payload in {
                "database.dump": b"database",
                "app-data.tar": b"application-data",
            }.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o600
                member.size = len(payload)
                bundle.addfile(member, io.BytesIO(payload))
        self.addCleanup(archive.unlink, missing_ok=True)

        result = self.validate(archive)
        self.assertNotEqual(result.returncode, 0)

    @unittest.skipUnless(shutil.which("openssl"), "openssl is not installed")
    def test_validates_an_encrypted_archive_only_with_its_passphrase(self) -> None:
        plain_archive = self.create_archive()
        passphrase_handle = tempfile.NamedTemporaryFile(delete=False)
        passphrase_handle.close()
        encrypted_handle = tempfile.NamedTemporaryFile(suffix=".enc", delete=False)
        encrypted_handle.close()
        passphrase = Path(passphrase_handle.name)
        encrypted = Path(encrypted_handle.name)
        passphrase.write_text("correct horse battery staple\n")
        self.addCleanup(passphrase.unlink, missing_ok=True)
        self.addCleanup(encrypted.unlink, missing_ok=True)
        subprocess.run(
            [
                "openssl", "enc", "-aes-256-cbc", "-pbkdf2", "-salt",
                "-pass", f"file:{passphrase}", "-in", str(plain_archive), "-out", str(encrypted),
            ],
            check=True,
        )

        missing_passphrase = self.validate(encrypted)
        self.assertNotEqual(missing_passphrase.returncode, 0)
        self.assertIn("backup is encrypted", missing_passphrase.stderr)
        valid = self.validate(encrypted, passphrase_file=passphrase)
        self.assertEqual(valid.returncode, 0, valid.stderr)


if __name__ == "__main__":
    unittest.main()
