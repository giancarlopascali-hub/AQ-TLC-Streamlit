# -*- mode: python ; coding: utf-8 -*-
"""Portable one-folder build. Only the desktop analysis imports are collected."""

import sys
from pathlib import Path

root = Path(SPECPATH).resolve().parent
staged_frontend = root / ".windows-build" / "staged" / "frontend"
site_packages = root / ".windows-build" / "venv" / "Lib" / "site-packages"
licenses = [
    (site_packages / "numpy-2.2.6.dist-info" / "LICENSE.txt", "licenses/numpy"),
    (site_packages / "scipy-1.14.1.dist-info" / "LICENSE.txt", "licenses/scipy"),
    (site_packages / "pillow-12.3.0.dist-info" / "licenses" / "LICENSE", "licenses/pillow"),
    (site_packages / "opencv_python_headless-4.13.0.92.dist-info" / "LICENSE.txt", "licenses/opencv"),
    (site_packages / "opencv_python_headless-4.13.0.92.dist-info" / "LICENSE-3RD-PARTY.txt", "licenses/opencv"),
    (site_packages / "pyinstaller-6.19.0.dist-info" / "licenses" / "COPYING.txt", "licenses/pyinstaller"),
    (Path(sys.base_prefix) / "LICENSE.txt", "licenses/python"),
]

a = Analysis(
    [str(root / "windows_desktop" / "launcher.py")],
    pathex=[str(root)],
    binaries=[],
    datas=[(str(staged_frontend), "frontend"), *((str(source), destination) for source, destination in licenses)],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "streamlit", "skimage", "skopt", "matplotlib", "pandas", "pyarrow",
        "altair", "plotly", "torch", "tensorflow", "pytest", "IPython",
        "notebook", "jupyter", "tkinter", "PyQt5", "PySide6",
    ],
    noarchive=False,
)
# Neither video decoding nor AVIF image decoding is used: the interface sends
# plate images to the backend as PNG/JPEG data URLs. Removing these optional
# binaries saves about 35 MB without changing the TLC calculations.
optional_binaries = ("cv2\\opencv_videoio_ffmpeg", "PIL\\_avif.")
a.binaries = [entry for entry in a.binaries if not entry[0].startswith(optional_binaries)]
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="AQ-TLC-Desktop",
    console=True,
    icon=str(root / "favicon.ico"),
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="AQ-TLC-Desktop")
