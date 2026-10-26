"""Copy the explicit public demo files into a portable static dist directory."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
FILES = (
    "index.html", "src/app.js", "src/styles.css", "src/host-adapter.js",
    "README.md", "README.zh-CN.md", "LICENSE", "SECURITY.md",
    "docs/ARCHITECTURE.md", "docs/TRACKING.md",
)
for name in FILES:
    source = ROOT / name
    if not source.is_file() or source.is_symlink():
        raise SystemExit(f"Missing or unsafe public file: {name}")
# Only manage paths listed above; never include arbitrary sibling files.
for name in FILES:
    target = DIST / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / name, target)
print(f"Built {len(FILES)} static files in dist/")
