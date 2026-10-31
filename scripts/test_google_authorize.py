"""Synthetic callback HTTP tests; no SDK, credentials or Google calls needed."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from google_authorize import AuthorizationServer, AUTH_URI, TOKEN_URI, SCOPES, load_configuration


class FakeCredentials:
    token = "synthetic-access-token"
    refresh_token = "synthetic-refresh-token"
    granted_scopes = SCOPES

    def to_json(self):
        return json.dumps({"token": self.token, "refresh_token": self.refresh_token,
                           "token_uri": TOKEN_URI, "client_id": "synthetic-client-id",
                           "client_secret": "synthetic-client-secret", "scopes": list(SCOPES)})


class FakeSession:
    max_redirects = 30

    def __init__(self):
        self.token = {"scope": list(SCOPES)}


class FakeFlow:
    def __init__(self):
        self.credentials = FakeCredentials()
        self.oauth2session = FakeSession()
        self.calls = []
        self.failure = None

    def fetch_token(self, **kwargs):
        self.calls.append(kwargs)
        if self.failure:
            raise self.failure


class CallbackTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.token_path = Path(self.directory.name) / "token.json"
        self.old_bytes = b'{"old":"synthetic-private-value"}'
        self.token_path.write_bytes(self.old_bytes)
        self.flow = FakeFlow()
        self.server = AuthorizationServer(self.flow, self.token_path)
        self.server.expected_state = "synthetic-expected-state"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, pairs=None, path="/", host=None):
        uri = "http://127.0.0.1:%s%s" % (self.server.server_port, path)
        if pairs is not None:
            uri += "?" + urlencode(pairs)
        req = Request(uri, headers={"Host": host or "127.0.0.1:%s" % self.server.server_port})
        try:
            response = urlopen(req, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.read().decode("utf-8"), response.headers

    def valid(self):
        return [("state", self.server.expected_state), ("code", "synthetic-authorization-code")]

    def unchanged(self):
        self.assertEqual(self.token_path.read_bytes(), self.old_bytes)

    def test_denial_is_failure_even_if_code_also_present_and_no_credentials_change(self):
        with contextlib.redirect_stderr(io.StringIO()) as logs:
            status, page, headers = self.request(self.valid() + [("error", "access_denied")])
        self.assertEqual(status, 403)
        self.assertIn("未保存", page)
        self.assertNotIn("Google 数据授权已保存", page)
        self.assertNotIn("synthetic-authorization-code", page + logs.getvalue())
        self.assertEqual(self.server.result, {"status": "failed", "code": "ACCESS_DENIED"})
        self.assertEqual(self.flow.calls, [])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("default-src 'none'", headers["Content-Security-Policy"])
        self.unchanged()

    def test_wrong_missing_duplicate_or_nonascii_state_does_not_consume_request(self):
        for state_pairs in [[], [("state", "wrong")], [("state", "")], [("state", "é")], [("state", self.server.expected_state)] * 2]:
            status, page, _ = self.request(state_pairs + [("code", "synthetic-authorization-code")])
            self.assertEqual(status, 400)
            self.assertIn("未保存", page)
            self.assertIsNone(self.server.result)
        self.assertEqual(self.flow.calls, [])
        self.unchanged()
        self.assertEqual(self.request(self.valid())[0], 200, "matching callback can still complete")

    def test_missing_or_duplicate_code_is_not_success(self):
        for codes in [[], [("code", "")], [("code", "one"), ("code", "two")]]:
            self.server.result = None
            status, page, _ = self.request([("state", self.server.expected_state)] + codes)
            self.assertEqual(status, 400)
            self.assertIn("未保存", page)
            self.assertEqual(self.flow.calls, [])
            self.unchanged()

    def test_missing_actual_scopes_or_refresh_token_never_overwrites_previous_grant(self):
        for scope in [[SCOPES[0]], [SCOPES[1]], [], None]:
            self.server.result = None
            self.flow.oauth2session.token["scope"] = scope
            self.flow.credentials.granted_scopes = None
            status, page, _ = self.request(self.valid())
            self.assertEqual(status, 502)
            self.assertIn("未保存", page)
            self.assertEqual(self.server.result["code"], "SCOPES_MISSING")
            self.unchanged()
        self.flow.oauth2session.token["scope"] = list(SCOPES)
        self.flow.credentials.refresh_token = None
        status, page, _ = self.request(self.valid())
        self.assertEqual(status, 502)
        self.assertIn("未保存", page)
        self.assertEqual(self.server.result["code"], "REFRESH_TOKEN_MISSING")
        self.unchanged()

    def test_provider_failure_and_scope_warning_are_sanitized_and_preserve_file(self):
        for failure, expected in [(RuntimeError("PRIVATE_PROVIDER_BODY synthetic-secret"), "EXCHANGE_FAILED"), (Warning("PRIVATE_SCOPE_RESPONSE"), "SCOPES_MISSING")]:
            self.flow.failure = failure
            with contextlib.redirect_stderr(io.StringIO()) as logs:
                status, page, _ = self.request(self.valid())
            self.assertGreaterEqual(status, 400)
            self.assertIn("未保存", page)
            self.assertNotIn("PRIVATE_", page + logs.getvalue())
            self.assertEqual(self.server.result["code"], expected)
            self.unchanged()

    def test_success_only_after_validated_atomic_private_save(self):
        status, page, headers = self.request(self.valid())
        self.assertEqual(status, 200)
        self.assertIn("Google 数据授权已保存", page)
        self.assertIn("不代表日报已经读取成功", page)
        self.assertEqual(self.server.result, {"status": "saved"})
        saved = json.loads(self.token_path.read_text())
        self.assertEqual(saved["refresh_token"], "synthetic-refresh-token")
        self.assertEqual(set(saved["scopes"]), set(SCOPES))
        self.assertEqual(self.token_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.flow.calls, [{"code": "synthetic-authorization-code", "timeout": 30}])
        self.assertEqual(self.flow.oauth2session.max_redirects, 0)
        self.assertEqual(list(Path(self.directory.name).glob(".google-oauth-*")), [])
        self.assertNotIn("synthetic-refresh-token", page)
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")

    def test_wrong_host_and_noncallback_paths_cannot_exchange_or_finish(self):
        for path, host in [("/", "example.com"), ("/other", None)]:
            status, page, _ = self.request(self.valid(), path=path, host=host)
            self.assertGreaterEqual(status, 400)
            self.assertIn("未保存", page)
            self.assertIsNone(self.server.result)
        self.assertEqual(self.flow.calls, [])
        self.unchanged()

    def test_failed_atomic_save_never_claims_success_or_replaces_old_file(self):
        with patch("google_authorize.os.replace", side_effect=OSError("PRIVATE_STORAGE_FAILURE")):
            status, page, _ = self.request(self.valid())
        self.assertEqual(status, 500)
        self.assertIn("未保存", page)
        self.assertNotIn("PRIVATE_STORAGE_FAILURE", page)
        self.assertEqual(self.server.result, {"status": "failed", "code": "SAVE_FAILED"})
        self.assertEqual(list(Path(self.directory.name).glob(".google-oauth-*")), [])
        self.unchanged()

    def test_configuration_rejects_non_google_endpoints_and_symlink_destination(self):
        root = Path(self.directory.name)
        config = root / "config.json"
        client = root / "client.json"
        config.write_text(json.dumps({"auth_mode": "user_oauth", "oauth_client_file": "client.json", "oauth_token_file": "token.json"}))
        client_data = {"installed": {"auth_uri": AUTH_URI, "token_uri": TOKEN_URI, "client_id": "synthetic-client", "client_secret": "synthetic-secret"}}
        client.write_text(json.dumps(client_data))
        self.assertEqual(load_configuration(config)[1], self.token_path)
        mixed = {**client_data, "web": {"auth_uri": "https://example.com/oauth", "token_uri": "https://example.com/token"}}
        client.write_text(json.dumps(mixed))
        self.assertEqual(load_configuration(config)[0], client_data, "SDK receives only the validated installed client")
        for key in ["auth_uri", "token_uri"]:
            bad = json.loads(json.dumps(client_data))
            bad["installed"][key] = "https://example.com/oauth"
            client.write_text(json.dumps(bad))
            with self.assertRaises(Exception):
                load_configuration(config)
        client.write_text(json.dumps(client_data))
        destination = root / "linked.json"
        destination.symlink_to(self.token_path)
        value = json.loads(config.read_text())
        value["oauth_token_file"] = "linked.json"
        config.write_text(json.dumps(value))
        with self.assertRaises(Exception):
            load_configuration(config)
        self.unchanged()

    def test_browser_disconnect_after_save_keeps_saved_result_without_raw_logs(self):
        with contextlib.redirect_stderr(io.StringIO()) as logs:
            with patch("google_authorize.CallbackHandler.end_headers", side_effect=ConnectionResetError("PRIVATE_BROKEN_CONNECTION")):
                with self.assertRaises(Exception):
                    self.request(self.valid())
        self.assertEqual(self.server.result, {"status": "saved"})
        self.assertNotEqual(self.token_path.read_bytes(), self.old_bytes)
        self.assertEqual(logs.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
