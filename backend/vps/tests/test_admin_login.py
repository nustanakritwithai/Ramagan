"""Read-only owner login diagnosis is tested against disposable SQLite only."""
import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from admin import main
from app import create_store, create_user

class LoginDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str(Path(self.tmp.name) / "ramagan-qa.sqlite3")
        self.store_id = create_store(self.path, "UAT Test Store")
        self.password = "StrongPassphraseThatIsNotARealSecret-987"
        create_user(self.path, self.store_id, "owner@example.test",
                    self.password, "owner")

    def cli(self, path, email, password=None):
        args = ["admin.py", "--db", path, "check-login", "--email", email]
        out = io.StringIO()
        with patch("sys.argv", args), patch(
            "getpass.getpass", return_value=password or ""
        ), redirect_stdout(out):
            code = main()
        return code, out.getvalue()

    def test_owner_password_matches_existing_database_without_mutation(self):
        code, output = self.cli(self.path, "OWNER@example.test", self.password)
        self.assertEqual(code, 0)
        self.assertIn("ACCOUNT: FOUND", output)
        self.assertIn("ROLE: owner", output)
        self.assertIn("SALES_ENABLED: False", output)
        self.assertIn("PASSWORD_MATCH: PASS", output)
        self.assertNotIn(self.password, output)

    def test_wrong_password_does_not_reset_or_create_anything(self):
        code, output = self.cli(self.path, "owner@example.test", "wrong")
        self.assertEqual(code, 2)
        self.assertIn("PASSWORD_MATCH: FAIL", output)
        followup, _ = self.cli(self.path, "owner@example.test", self.password)
        self.assertEqual(followup, 0)

    def test_missing_account_reports_not_found_without_password_echo(self):
        code, output = self.cli(self.path, "noone@example.test", self.password)
        self.assertEqual(code, 2)
        self.assertIn("ACCOUNT: NOT_FOUND", output)
        self.assertNotIn(self.password, output)

    def test_missing_database_refuses_empty_bootstrap(self):
        other = str(Path(self.tmp.name) / "wrong-db.sqlite3")
        with self.assertRaisesRegex(ValueError, "Database file not found"):
            self.cli(other, "owner@example.test", self.password)
        self.assertFalse(Path(other).exists())

if __name__ == "__main__":
    unittest.main()
