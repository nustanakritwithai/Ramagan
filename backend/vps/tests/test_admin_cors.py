"""CORS regression for GitHub Pages Admin -> Windows VPS Ramagan API.

No credentials, no real VPS, no production data. OPTIONS preflight is what
mobile Chrome sends before JSON login and bearer-token dashboard queries.
"""
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from app import create_app


class GitHubPagesCorsTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.api = create_app(
            str(Path(self.folder.name) / "cors.sqlite3"),
            origins=[
                "https://localhost",
                "https://nustanakritwithai.github.io",
            ],
        )
        self.client = TestClient(self.api)
        self.addCleanup(self.client.close)

    def preflight(self, origin, target, method, headers):
        return self.client.options(target, headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
        })

    def test_admin_login_json_post_preflight(self):
        r = self.preflight(
            "https://nustanakritwithai.github.io",
            "/v1/auth/login",
            "POST",
            "content-type",
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            r.headers.get("access-control-allow-origin"),
            "https://nustanakritwithai.github.io",
        )
        self.assertIn("POST", r.headers.get("access-control-allow-methods", ""))
        self.assertIn("content-type",
                      r.headers.get("access-control-allow-headers", "").lower())
        self.assertNotEqual(r.headers.get("access-control-allow-origin"), "*")

    def test_admin_authorized_report_get_preflight(self):
        r = self.preflight(
            "https://nustanakritwithai.github.io",
            "/v1/admin/sales-report",
            "GET",
            "authorization",
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            r.headers.get("access-control-allow-origin"),
            "https://nustanakritwithai.github.io",
        )
        self.assertIn("authorization",
                      r.headers.get("access-control-allow-headers", "").lower())

    def test_local_android_origin_unchanged(self):
        r = self.preflight("https://localhost", "/v1/auth/login",
                           "POST", "content-type")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("access-control-allow-origin"),
                         "https://localhost")

    def test_untrusted_origin_is_not_allowed(self):
        r = self.preflight("https://random.example", "/v1/auth/login",
                           "POST", "content-type")
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("access-control-allow-origin", r.headers)

    def test_real_get_health_carries_allowed_cors_response_header(self):
        r = self.client.get("/health", headers={
            "Origin": "https://nustanakritwithai.github.io",
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")
        self.assertEqual(r.headers.get("access-control-allow-origin"),
                         "https://nustanakritwithai.github.io")


if __name__ == "__main__":
    unittest.main()
