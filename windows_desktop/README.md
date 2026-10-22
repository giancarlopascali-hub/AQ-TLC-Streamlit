# Portable Windows build

The Windows package uses the `frontend/` interface and `tlc_backend.py` from
this desktop repository. `launcher.py` replaces the Streamlit host with a local
HTTP server; `streamlit_bridge.js` replaces only the component transport. The
scientific backend is imported unchanged. No network service is required.

The release folder contains `AQ-TLC-Desktop.exe`, `_internal/`, and a short
`README.txt` copied from `README-PACKAGE.txt`. Keep the executable and `_internal/` together. Double-click the
executable; it opens the app in the default browser at a local address. Close
the executable's console window when finished. The workspace is session-only,
as in the Streamlit desktop version.

Build on 64-bit Windows with Python 3.11 by running `build.ps1`. It creates an
isolated environment from `requirements-build.txt`, runs the host tests, stages
the frontend, builds the executable, writes the Desktop ZIP, and removes its
temporary build directory. Use `-KeepBuild` when debugging a new build. The spec
collects imported code, required licenses, and the 18 small frontend files. It
omits unused video and AVIF decoders rather than copying entire optional
libraries. Build output belongs in `.windows-build/`, which is ignored and can
be removed after checking the ZIP.
