#!/usr/bin/env python3
"""Google installed-app authorization with truthful loopback result pages.

Only main() needs google-auth-oauthlib. The callback and tests use the stdlib.
No advertising API is called. A saved grant is not a successful report read.
"""
import argparse
import html
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
SCOPES = (
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/adwords",
)


class AuthorizationFailure(Exception):
    """Contains a fixed, public error code only; never a provider response."""


def private_json(path):
    if not path.is_file() or path.stat().st_size > 128 * 1024:
        raise AuthorizationFailure("CONFIG_INVALID")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AuthorizationFailure("CONFIG_INVALID")
    return value


def resolve_private(value, directory):
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise AuthorizationFailure("CONFIG_INVALID")
    path = Path(value)
    return path if path.is_absolute() else directory / path


def load_configuration(config_path):
    config_path = Path(config_path).absolute()
    config = private_json(config_path)
    if config.get("auth_mode") != "user_oauth":
        raise AuthorizationFailure("CONFIG_INVALID")
    client_path = resolve_private(config.get("oauth_client_file"), config_path.parent)
    token_path = resolve_private(config.get("oauth_token_file"), config_path.parent)
    client = private_json(client_path)
    # Only an installed client with the original, fixed Google destinations.
    installed = client.get("installed")
    if not isinstance(installed, dict) or installed.get("auth_uri") != AUTH_URI or installed.get("token_uri") != TOKEN_URI:
        raise AuthorizationFailure("CONFIG_INVALID")
    if not all(valid_secret(installed.get(key)) for key in ("client_id", "client_secret")):
        raise AuthorizationFailure("CONFIG_INVALID")
    if token_path.is_symlink():
        raise AuthorizationFailure("CONFIG_INVALID")
    # Flow.from_client_config prefers a web entry if both are present. Project
    # only the installed client we actually validated before constructing it.
    return {"installed": installed}, token_path


def valid_secret(value):
    return isinstance(value, str) and 0 < len(value) <= 16384 and all(ord(c) >= 32 and ord(c) != 127 for c in value)


def persist_credentials(flow, token_path):
    credentials = flow.credentials
    token = flow.oauth2session.token
    granted = token.get("scope") if isinstance(token, dict) else None
    if granted is None:
        granted = getattr(credentials, "granted_scopes", None)
    if isinstance(granted, str):
        granted = granted.split()
    if not isinstance(granted, (list, tuple, set)) or not set(SCOPES).issubset(granted):
        raise AuthorizationFailure("SCOPES_MISSING")
    if not valid_secret(getattr(credentials, "token", None)) or not valid_secret(getattr(credentials, "refresh_token", None)):
        raise AuthorizationFailure("REFRESH_TOKEN_MISSING")
    serialized = credentials.to_json()
    parsed = json.loads(serialized)
    if (not isinstance(parsed, dict) or parsed.get("token_uri") != TOKEN_URI
            or not all(valid_secret(parsed.get(key)) for key in ("token", "refresh_token", "client_id", "client_secret"))
            or not set(SCOPES).issubset(parsed.get("scopes") or [])):
        raise AuthorizationFailure("CREDENTIALS_INVALID")
    token_path = Path(token_path)
    token_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if token_path.is_symlink():
        raise AuthorizationFailure("CONFIG_INVALID")
    descriptor, temporary = tempfile.mkstemp(prefix=".google-oauth-", suffix=".json", dir=token_path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, token_path)
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass


class AuthorizationServer(HTTPServer):
    allow_reuse_address = False

    def __init__(self, flow, token_path):
        super().__init__(("127.0.0.1", 0), CallbackHandler)
        self.flow = flow
        self.token_path = Path(token_path)
        self.expected_state = None
        self.result = None
        self.timeout = 0.25

    def handle_error(self, _request, _client_address):
        pass  # Default tracebacks can expose callback or provider material.


FAILURES = {
    "ACCESS_DENIED": "Google 未授予访问权限，本次未保存授权。请重新发起授权，并核对最后的权限选择。",
    "CODE_MISSING": "Google 没有返回授权码，本次未保存授权。请重新发起授权。",
    "SCOPES_MISSING": "授权未包含原有的 Analytics 读取与 Google Ads 权限，本次未保存，也未覆盖原文件。请在权限页核对这两项。",
    "REFRESH_TOKEN_MISSING": "Google 没有返回可续期的授权，本次未保存，也未覆盖原文件。请重新发起授权。",
    "EXCHANGE_FAILED": "未能完成 Google 授权核对，本次未保存，也未覆盖原文件。请检查连接后重新发起授权。",
    "SAVE_FAILED": "未能安全保存授权，本次未覆盖原文件。请检查本机私有文件目录后重新发起授权。",
}


class CallbackHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Callback URLs contain credentials and must never enter logs.

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def page(self, status, title, message):
        content = ("<!doctype html><html lang='zh-CN'><meta charset='utf-8'>"
                   "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                   f"<title>{html.escape(title)}</title><h1>{html.escape(title)}</h1>"
                   f"<p>{html.escape(message)}</p></html>").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The saved/failed result is independent of browser closure.

    def finish_failure(self, code, status=400):
        self.server.result = {"status": "failed", "code": code}
        self.page(status, "授权未完成，未保存", FAILURES[code])

    def do_GET(self):
        expected_host = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") != expected_host or len(self.path) > 16384:
            self.page(400, "回调无效", "本次未保存授权。请回到原授权页面重试。")
            return
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self.page(400, "回调无效", "本次未保存授权。")
            return
        if parsed.path != "/" or parsed.scheme or parsed.netloc:
            self.page(404, "没有找到页面", "本次未保存授权。")
            return
        query = parse_qs(parsed.query, keep_blank_values=True)
        states = query.get("state", [])
        expected_state = self.server.expected_state
        if (len(states) != 1 or not expected_state or not states[0]
                or not secrets.compare_digest(states[0].encode("utf-8"), expected_state.encode("utf-8"))):
            self.page(400, "回调不匹配", "本次未保存授权。原授权请求仍在等待，请回到原授权页面重试。")
            return
        if "error" in query:
            self.finish_failure("ACCESS_DENIED", 403)
            return
        codes = query.get("code", [])
        if len(codes) != 1 or not valid_secret(codes[0]):
            self.finish_failure("CODE_MISSING")
            return
        try:
            # OAuthlib adds the original PKCE verifier; our constant-time state
            # check occurs before this code-only exchange. Never follow redirects.
            self.server.flow.oauth2session.max_redirects = 0
            self.server.flow.fetch_token(code=codes[0], timeout=30)
        except Warning:
            self.finish_failure("SCOPES_MISSING", 403)
            return
        except Exception:
            self.finish_failure("EXCHANGE_FAILED", 502)
            return
        try:
            persist_credentials(self.server.flow, self.server.token_path)
        except AuthorizationFailure as error:
            code = str(error)
            self.finish_failure(code if code in FAILURES else "SAVE_FAILED", 502)
            return
        except Exception:
            self.finish_failure("SAVE_FAILED", 500)
            return
        self.server.result = {"status": "saved"}
        self.page(200, "Google 数据授权已保存", "现在可以关闭此页，回到广告增长工作区继续读取日报。授权已保存，不代表日报已经读取成功。")


def main(argv=None):
    parser = argparse.ArgumentParser(description="恢复原有 Google 数据授权；不读取或修改广告。")
    parser.add_argument("--config", required=True, help="已有私有 Google 集成配置文件")
    parser.add_argument("--login-hint", default="", help="可选：要使用的现有 Google 账号")
    parser.add_argument("--timeout", type=int, default=600, help="等待本人授权的秒数（30–1800）")
    args = parser.parse_args(argv)
    if not 30 <= args.timeout <= 1800 or len(args.login_hint) > 254 or any(ord(c) < 32 for c in args.login_hint):
        parser.error("授权等待时间或账号提示不正确。")
    os.umask(0o077)
    try:
        client, token_path = load_configuration(args.config)
        from google_auth_oauthlib.flow import InstalledAppFlow
        flow = InstalledAppFlow.from_client_config(client, SCOPES, autogenerate_code_verifier=True)
        with AuthorizationServer(flow, token_path) as server:
            flow.redirect_uri = f"http://127.0.0.1:{server.server_port}/"
            options = {"access_type": "offline", "prompt": "consent"}
            if args.login_hint:
                options["login_hint"] = args.login_hint
            authorization_url, state = flow.authorization_url(**options)
            if urlsplit(authorization_url).scheme != "https" or urlsplit(authorization_url).netloc != "accounts.google.com":
                raise AuthorizationFailure("CONFIG_INVALID")
            server.expected_state = state
            print("Open this URL in the signed-in Google browser:\n" + authorization_url, flush=True)
            deadline = time.monotonic() + args.timeout
            while server.result is None and time.monotonic() < deadline:
                server.handle_request()
            result = server.result or {"status": "failed", "code": "AUTHORIZATION_TIMEOUT"}
    except KeyboardInterrupt:
        result = {"status": "failed", "code": "AUTHORIZATION_CANCELLED"}
    except ImportError:
        result = {"status": "failed", "code": "GOOGLE_AUTH_LIBRARY_REQUIRED"}
    except Exception:
        result = {"status": "failed", "code": "CONFIG_OR_START_FAILED"}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result["status"] == "saved" else 1


if __name__ == "__main__":
    raise SystemExit(main())
