"""Build only the independent static workflow demo, never the team backend."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
FILES = (
    "index.html", "src/app.js", "src/styles.css", "src/host-adapter.js",
    "README.md", "README.zh-CN.md", "README.en.md", "LICENSE", "SECURITY.md",
    "docs/ARCHITECTURE.md", "docs/DEVELOPMENT.md", "docs/TRACKING.md",
)
for name in FILES:
    source = ROOT / name
    if not source.is_file() or source.is_symlink():
        raise SystemExit(f"Missing or unsafe public demo file: {name}")
if DIST.is_symlink():
    raise SystemExit("dist/ must not be a symlink")
# Reject a pre-existing output path that could redirect a copied file elsewhere.
for name in FILES:
    target = DIST / name
    for parent in (target, *target.parents):
        if parent == ROOT:
            break
        if parent.is_symlink():
            raise SystemExit(f"Unsafe output path: {name}")
# Replace generated output so stale files cannot leak into a later demo bundle.
if DIST.exists():
    shutil.rmtree(DIST)
# Use only the explicit public list; do not copy arbitrary siblings or data files.
for name in FILES:
    target = DIST / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / name, target)
print(f"Built {len(FILES)} static-demo files in dist/; team application requires the Node server.")
