"""
streamlit_app.py
================
AQ-TLC v1.1 -- Streamlit Cloud entry point.

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
    page_title="AQ-TLC v1.1",
    page_icon=_favicon,
    layout="wide",
    initial_sidebar_state="collapsed",
    menu_items={
        "About": "AQ-TLC v1.1 -- Advanced Quantitative TLC Analysis\nBy Giancarlo Pascali",
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
if "processed_request_ids" not in st.session_state:
    st.session_state.processed_request_ids = []

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
def _response(action, request_id, ok, data=None, error=None):
    """Build one versioned response envelope for every component action."""
    return {
        "protocol_version": 1,
        "action": f"{action}_result" if not action.endswith("_result") else action,
        "request_id": request_id,
        "ok": ok,
        "data": data if ok else None,
        "error": error,
    }


if component_value is not None:
    action = component_value.get("action") if isinstance(component_value, dict) else None
    request_id = str(component_value.get("request_id", "")) if isinstance(component_value, dict) else ""
    payload = component_value.get("payload", {}) if isinstance(component_value, dict) else {}
    protocol_version = component_value.get("protocol_version", 1) if isinstance(component_value, dict) else None
    processed = st.session_state.processed_request_ids

    if protocol_version != 1 or not action or not request_id:
        invalid_key = f"invalid:{request_id}:{action}"
        if invalid_key not in processed:
            st.session_state.pending_response = _response(
                action or "protocol_error",
                request_id,
                False,
                error={
                    "code": "INVALID_PROTOCOL",
                    "message": "The application sent an invalid request.",
                    "retryable": False,
                },
            )
            processed.append(invalid_key)
            if len(processed) > 128:
                del processed[:-128]
            st.rerun()
        else:
            st.session_state.pending_response = None
    elif request_id not in processed:
        if action == "generate_profiles":
            result = tlc_backend.generate_profiles(payload)
        elif action == "crop":
            result = tlc_backend.crop_image(payload)
        else:
            result = None

        if result is None:
            st.session_state.pending_response = _response(
                action,
                request_id,
                False,
                error={
                    "code": "UNKNOWN_ACTION",
                    "message": "That action is not supported.",
                    "retryable": False,
                },
            )
        elif result.get("error"):
            st.session_state.pending_response = _response(
                action,
                request_id,
                False,
                error={
                    "code": result.get("error_code", "PROCESSING_ERROR"),
                    "message": result["error"],
                    "retryable": result.get("error_code") == "PROCESSING_ERROR",
                },
            )
        else:
            st.session_state.pending_response = _response(action, request_id, True, data=result)

        processed.append(request_id)
        # Keep idempotency data bounded; action-scoped correlation happens in JS.
        if len(processed) > 128:
            del processed[:-128]
        st.rerun()
    else:
        # The component can replay its last value after a rerun.  The reply was
        # already delivered, so clear it rather than applying it a second time.
        st.session_state.pending_response = None
