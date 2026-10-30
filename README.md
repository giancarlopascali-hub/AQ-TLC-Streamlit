# AQ-TLC Desktop v1.0

AQ-TLC Desktop is a Streamlit-hosted quantitative thin-layer chromatography
workspace with a three-panel canvas interface for plate geometry,
densitograms, calibration and printable analytical reports.

## Production source

The production source is the `main` branch of:

- Repository: `giancarlopascali-hub/AQ-TLC-Streamlit`
- Branch: `main`
- Streamlit entrypoint: `streamlit_app.py`
- Supported deployment Python: `3.11`

Feature branches are temporary development work and must not be used as
permanent Streamlit deployment coordinates. See the
[Streamlit deployment runbook](docs/deployment-runbook.md) for first-time
deployment, moving an existing app from an old branch, routine updates and
rollback.

## Architecture

- `frontend/` — interactive HTML/CSS/JavaScript canvas interface and quick
  guide
- `streamlit_app.py` — Streamlit entrypoint and custom-component host
- `tlc_backend.py` — OpenCV/SciPy analytical backend
- `tests/` — Python and JavaScript regression tests

The JavaScript component sends versioned requests to the Streamlit host, which
runs the Python analysis and returns correlated responses to the browser.

## Capabilities

- Drag-and-drop or file-browser image loading
- ROI crop, rotation, pan and zoom
- Origin/front boundary lines and spotting marks
- Automatic lane geometry and server-computed densitograms
- Adjustable polarity, sensitivity, resolution and peak-width presentation
- Manual peak add, move, resize and delete workflows
- RGB channel-projection controls with custom target and adjustable RGB window, and colour inversion
- Relative, area-calibration and molecular-weight calibration modes
- Active-lane and multi-lane printable reports
- Up to 50 in-session undo snapshots with `Ctrl+Z` or `Command+Z`

The RGB controls are image-processing weightings, not physical spectrometer or
monochromator measurements. AQ-TLC is an analytical aid and must be validated
for the intended laboratory method.

## Session and privacy

The Desktop workspace is temporary and does not currently save a project file
for later reopening. Export required reports before refreshing, closing the
tab or allowing the Streamlit session to restart.

Plate images are sent to the selected Streamlit deployment for analysis. Do
not upload sensitive material until the app's access mode and the
organisation's privacy requirements have been confirmed.

## Local development

Use Python 3.11.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt pytest
streamlit run streamlit_app.py
```

Open the local URL printed by Streamlit.

Run the automated checks with:

```powershell
python -m py_compile streamlit_app.py tlc_backend.py
python -m pytest -q tests/test_tlc_backend.py
node tests/javascript/analysis.test.mjs
```

## Deployment

Deploy and update only from GitHub `main`. Detailed Streamlit Community Cloud
instructions and the post-deployment acceptance checklist are in
[docs/deployment-runbook.md](docs/deployment-runbook.md).

The touch-oriented Mobile app is maintained independently in
`giancarlopascali-hub/TLC-APP-PWA` and is also deployed from its `main` branch.
