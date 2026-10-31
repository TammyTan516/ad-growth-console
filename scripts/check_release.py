"""Check the public source boundary without reading private runtime directories.

This is a conservative packaging aid, not a complete secret or security audit.
"""
from pathlib import Path
import os
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {
    ".gitignore", ".env.example", "LICENSE", "README.md", "README.zh-CN.md", "README.en.md",
    "SECURITY.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "index.html",
}
SOURCE_SUFFIXES = {
    "src": {".js", ".css", ".html"},
    "workspace": {".js", ".mjs", ".css", ".html"},
    "server": {".js", ".mjs", ".json", ".sql"},
    "runner": {".mjs"},
    "tests": {".js", ".mjs", ".cjs", ".json"},
    "scripts": {".py", ".js", ".mjs"},
    "docs": {".md"},
}
REQUIRED = {
    ".gitignore", ".env.example", "LICENSE", "README.md", "README.zh-CN.md", "README.en.md",
    "SECURITY.md", "package.json", "index.html", "docs/ARCHITECTURE.md",
    "docs/DEVELOPMENT.md", "docs/TRACKING.md", "scripts/check_release.py",
    "scripts/build.py", "src/app.js", "src/styles.css", "src/host-adapter.js",
    "tests/workflow.test.cjs", "tests/storage.test.cjs", "tests/team.test.mjs",
    "pnpm-lock.yaml", "server/app.mjs", "server/auth.mjs",
    "server/index.mjs", "server/store.mjs", "server/errors.mjs", "server/validation.mjs",
    "workspace/index.html", "workspace/app.js", "workspace/styles.css",
    "server/connectors.mjs", "runner/client.mjs", "runner/codex.mjs", "runner/connect.mjs",
    "tests/connectors.test.mjs", "tests/runner.test.mjs", "docs/CODEX-CONNECTOR.md",
    "server/execution.mjs", "server/execution-validation.mjs", "runner/browser-client.mjs",
    "tests/execution.test.mjs", "tests/browser-client.test.mjs",
    "docs/BROWSER-EXECUTION.md", "docs/PLATFORM-BROWSER.md",
    "server/google-ads-reader.mjs", "server/reporting.mjs", "docs/REPORTING.md",
    "tests/google-ads-reader.test.mjs", "tests/reporting.test.mjs",
    "tests/reporting-http.test.mjs", "tests/reporting-ui.test.mjs",
    "scripts/google_authorize.py", "scripts/test_google_authorize.py",
    "tests/google-authorization.test.mjs",
}
IGNORED_DIRS = {".git", "dist", "node_modules", ".local", "coverage", "__pycache__"}
RULES = {
    "private key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "access token": r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})",
    "credential in URL": r"https?://[^\s/]+:[^\s/@]+@",
    "personal filesystem path": r"(?:/Users/|/home/|[A-Z]:\\Users\\)[^\s]+",
    "private service link": r"https?://[^\s\"'<>]*(?:\.internal[./]|\.feishu\.cn/|\.larksuite\.com/)",
}


def allowed(name):
    path = Path(name)
    if name in ROOT_FILES:
        return True
    return (
        len(path.parts) >= 2
        and path.parts[0] in SOURCE_SUFFIXES
        and path.suffix in SOURCE_SUFFIXES[path.parts[0]]
        and all(not part.startswith(".") for part in path.parts)
    )


errors = []
actual = set()
for current, directories, files in os.walk(ROOT, followlinks=False):
    base = Path(current)
    # Never traverse dependencies, generated demo output, or private state.
    directories[:] = [name for name in directories if name not in IGNORED_DIRS]
    for name in list(directories):
        if (base / name).is_symlink():
            errors.append(f"Symlink excluded from release: {(base / name).relative_to(ROOT)}")
            directories.remove(name)
    for name in files:
        if name == ".DS_Store" or (name != ".env.example" and (name == ".env" or name.startswith(".env."))):
            continue  # Private local configuration is checked separately if tracked.
        path = base / name
        relative = path.relative_to(ROOT).as_posix()
        if path.is_symlink():
            errors.append(f"Symlink excluded from release: {relative}")
        else:
            actual.add(relative)

for name in sorted(actual):
    if not allowed(name):
        errors.append(f"Unexpected public source file: {name}")
for name in sorted(REQUIRED - actual):
    errors.append(f"Missing required public file: {name}")

# .gitignore does not protect a private file that has already been staged/tracked.
tracked = subprocess.run(
    ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=False
)
if tracked.returncode == 0:
    for raw in tracked.stdout.split(b"\0"):
        if not raw:
            continue
        name = raw.decode("utf-8")
        if not allowed(name):
            errors.append(f"Tracked file outside the public boundary: {name}")

for name in sorted(actual):
    if not allowed(name):
        continue
    try:
        text = (ROOT / name).read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        errors.append(f"Public source is not readable UTF-8 text: {name}")
        continue
    if name == "scripts/check_release.py":
        continue  # This detector intentionally includes risk signatures.
    for label, pattern in RULES.items():
        if re.search(pattern, text):
            errors.append(f"Review required ({label}): {name}")
    # The legacy demo must continue using public example destinations only.
    if name.startswith("src/"):
        for url in re.findall(r"https?://[^\s\"'<>`]+", text):
            if not url.startswith("https://example.com/"):
                errors.append(f"Unexpected demo source URL in {name}")

if errors:
    raise SystemExit("\n".join(errors))
print(f"Public source boundary and basic sensitive-content checks passed for {len(actual)} files.")
