"""
streamlit_app.py
================
AQ-TLC v1.0 -- Streamlit Cloud entry point.

Architecture
------------
The HTML/CSS/JS canvas UI runs inside a Streamlit custom component (an iframe
served from ./frontend/).

Communication flow:
  1. JS sends stSend({action, payload, request_id}) via streamlit_bridge.js.
  2. Streamlit reruns; `component_value` holds the request.
  3. Python computes the result and re-renders with `response=` args.
  4. JS receives args via the global render callback buffer and updates UI.

The "streamlit:componentReady" message is sent IMMEDIATELY by an inline
<script> in frontend/index.html -- before any ES module loads -- so the
60-second component-timeout is never reached.
"""

import os
import sys
from PIL import Image
import streamlit as st
import streamlit.components.v1 as components

import tlc_backend

# ---------------------------------------------------------------------------
# Page config & favicon
# ---------------------------------------------------------------------------
_ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
_FAVICON_PATH = os.path.join(_ROOT_DIR, "favicon.ico")
_favicon = Image.open(_FAVICON_PATH) if os.path.exists(_FAVICON_PATH) else None

st.set_page_config(
    page_title="AQ-TLC v1.0",
    page_icon=_favicon,
    layout="wide",
    initial_sidebar_state="collapsed",
    menu_items={
        "About": "AQ-TLC v1.0 -- Advanced Quantitative TLC Analysis\nBy Giancarlo Pascali",
    },
)

# ---------------------------------------------------------------------------
# Hide Streamlit chrome so the component fills the full viewport
# ---------------------------------------------------------------------------
st.markdown(
    """
    <style>
        #MainMenu  { visibility: hidden; }
        footer     { visibility: hidden; }
        header     { visibility: hidden; }
        section[data-testid="stSidebar"] { display: none; }
        .block-container { padding: 0 !important; max-width: 100% !important; }
        iframe[title="aq_tlc.aq_tlc"] { border: none; }
    </style>
    """,
    unsafe_allow_html=True,
)

# ---------------------------------------------------------------------------
# Declare custom component
# ---------------------------------------------------------------------------
_FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")

if not os.path.isdir(_FRONTEND_DIR):
    st.error(
        f"Component frontend directory not found: {_FRONTEND_DIR}\n\n"
        "Make sure the `frontend/` folder exists in the repository root."
    )
    st.stop()

_component_func = components.declare_component("aq_tlc", path=_FRONTEND_DIR)

# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------
if "pending_response" not in st.session_state:
    st.session_state.pending_response = None
if "last_req_id" not in st.session_state:
    st.session_state.last_req_id = None

# ---------------------------------------------------------------------------
# Render the component
# ---------------------------------------------------------------------------
# Height: fill the viewport. Streamlit Cloud viewport is typically ~900px.
# The component's inline script calls stSetHeight(window.innerHeight) on load,
# but we pass a generous default here so the iframe is never clipped.
component_value = _component_func(
    response=st.session_state.pending_response,
    key="aq_tlc_main",
    default=None,
    height=900,
)

# ---------------------------------------------------------------------------
# Process requests from JS
# ---------------------------------------------------------------------------
if component_value is not None:
    action  = component_value.get("action")
    req_id  = str(component_value.get("request_id", ""))
    payload = component_value.get("payload", {})

    # Deduplicate: only process each request_id once
    if req_id and req_id != st.session_state.last_req_id:
        st.session_state.last_req_id = req_id

        if action == "generate_profiles":
            result = tlc_backend.generate_profiles(payload)
            st.session_state.pending_response = {
                "action": "generate_profiles_result",
                "data":   result,
            }

        elif action == "crop":
            result = tlc_backend.crop_image(payload)
            st.session_state.pending_response = {
                "action": "crop_result",
                "data":   result,
            }

        else:
            st.session_state.pending_response = None

        st.rerun()

    else:
        # No new request -- clear stale response so it is not replayed
        st.session_state.pending_response = None