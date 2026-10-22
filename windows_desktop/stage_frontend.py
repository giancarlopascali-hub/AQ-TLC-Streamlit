"""Copy only runtime frontend files and replace Streamlit transport."""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path


def stage(destination: Path) -> None:
    repo = Path(__file__).resolve().parent.parent
    source = repo / "frontend"
    if destination.exists():
        raise FileExistsError(f"Staging target already exists: {destination}")
    shutil.copytree(source, destination)
    shutil.copyfile(repo / "windows_desktop" / "streamlit_bridge.js", destination / "modules" / "streamlit_bridge.js")

    # System font fallbacks are already in CSS. Omit remote font requests so
    # opening the packaged app does not require an internet connection.
    index = destination / "index.html"
    html = index.read_text(encoding="utf-8")
    html = re.sub(r"^\s*<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\s*\n", "", html, flags=re.MULTILINE)
    index.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    stage(Path(sys.argv[1]).resolve())
