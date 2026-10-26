"""Conservative public-demo packaging check; not a replacement for manual review."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_FILES = {
    ".gitignore", "LICENSE", "README.md", "README.zh-CN.md", "SECURITY.md",
    "package.json", "index.html", "src/app.js", "src/styles.css", "src/host-adapter.js",
    "tests/workflow.test.cjs", "tests/storage.test.cjs", "scripts/build.py",
    "scripts/check_release.py", "docs/ARCHITECTURE.md", "docs/TRACKING.md",
}
RULES = {
    "private key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "access token": r"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})",
    "credential in URL": r"https?://[^\s/]+:[^\s/@]+@",
    "personal filesystem path": r"(?:/Users/|/home/|[A-Z]:\\Users\\)[^\s]+",
    "private service link": r"https?://[^\s\"'<>]*(?:\.internal[./]|\.feishu\.cn/|\.larksuite\.com/)",
}
errors = []
actual = set()
for file in ROOT.rglob("*"):
    relative = file.relative_to(ROOT)
    if any(part in {".git", "dist", "__pycache__", "node_modules"} for part in relative.parts):
        continue
    if file.is_symlink():
        errors.append(f"Symlink excluded from release: {relative}")
    elif file.is_file():
        actual.add(relative.as_posix())
for name in sorted(actual - PUBLIC_FILES):
    errors.append(f"Unexpected file: {name}")
for name in sorted(PUBLIC_FILES - actual):
    errors.append(f"Missing file: {name}")
for name in sorted(actual & PUBLIC_FILES):
    text = (ROOT / name).read_text(encoding="utf-8")
    if name == "scripts/check_release.py":
        continue  # The scanner intentionally contains signatures, not credentials.
    for label, pattern in RULES.items():
        if re.search(pattern, text):
            errors.append(f"Review required ({label}): {name}")
    if name.startswith("src/"):
        for url in re.findall(r"https?://[^\s\"'<>`]+", text):
            if not url.startswith("https://example.com/"):
                errors.append(f"Unexpected source URL in {name}")
if errors:
    raise SystemExit("\n".join(errors))
print(f"Public allowlist and basic sensitive-content checks passed for {len(PUBLIC_FILES)} files.")
