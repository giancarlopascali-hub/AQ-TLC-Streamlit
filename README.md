# AQ-TLC v1.0 — Streamlit Edition

**Advanced Quantitative Thin Layer Chromatography Analysis**  
By [Giancarlo Pascali](mailto:g.pascali@unsw.edu.au)

A high-precision densitometry and quantitative chromatography analysis
workstation deployed as a Streamlit web app.

---

## Architecture

The app uses a **Streamlit custom component** architecture:

- **`frontend/`** — The full interactive HTML/CSS/JS canvas UI (unchanged from the desktop version), served as a Streamlit component iframe.
- **`streamlit_app.py`** — The Streamlit entry point; routes requests from the JS frontend to the Python backend and returns responses.
- **`tlc_backend.py`** — Pure Python computation (OpenCV, scikit-image, scipy); no Flask dependency.

Communication between the JS canvas and Python uses the Streamlit component postMessage protocol implemented in `frontend/modules/streamlit_bridge.js`.

---

## Local Development

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Run the app
streamlit run streamlit_app.py
```

Open http://localhost:8501 in your browser.

---

## Deploy to Streamlit Community Cloud

1. Push this repository to GitHub (already done).
2. Go to https://share.streamlit.io and sign in with your GitHub account.
3. Click **New app** ? select this repository ? set **Main file path** to `streamlit_app.py`.
4. Click **Deploy**.

> **Note:** Streamlit Community Cloud provides 1 GB RAM per app. Large images and
> the Bayesian optimisation (`scikit-optimize`) may approach this limit.
> For heavy usage, consider a paid tier or self-hosted deployment.

---

## Features

- ?? **Image Upload** — drag-and-drop or browse
- ?? **Lane Drawing** — draw Origin/Front lines and spotting marks on the canvas
- ?? **Find Lanes** — auto-calculate lane bounding boxes
- ?? **Density Profiles** — server-computed 1-D densitograms per lane
- ?? **Peak Detection** — scipy `find_peaks` with adjustable sensitivity/resolution
- ?? **Wavelength Filtering** — spectral channel weighting (UV-254, Ninhydrin, Iodine, PMA, custom ?)
- ?? **ROI Crop** — server-side crop with rotation correction
- ?? **Undo** — Ctrl+Z undo stack (50 levels)
- ?? **Export** — CSV / PDF report generation
