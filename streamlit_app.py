"""
streamlit_app.py
================
AQ-TLC v1.0 — Streamlit Cloud entry point.

Architecture
------------
The entire HTML/CSS/JS canvas UI runs inside a Streamlit custom component
(an iframe served from the ./frontend/ directory).

Communication flow:
  1. User performs an action in the JS frontend (e.g. Find Lanes).
  2. JS calls stSend({action, payload, request_id}) via streamlit_bridge.js.
  3. Streamlit reruns this script; `component_value` contains the request.
  4. Python computes the result (generate_profiles or crop_image).
  5. Python re-renders the component, passing `response=` as args.
  6. JS receives args via the streamlit:render event and updates the UI.

Session state keys
------------------
  pending_response : dict | None  — response to send to the component next render
  last_req_id      : str          — stringified last processed request_id (dedup)
"""

import streamlit as st
import streamlit.components.v1 as components
import os

import tlc_backend

# -- Page configuration --------------------------------------------------------

st.set_page_config(
    page_title="AQ-TLC v1.0",
    page_icon="??",
    layout="wide",
    initial_sidebar_state="collapsed",
    menu_items={
        "Get Help": "https://github.com/giancarlopascali-hub/AQ-TLC-streamlit",
        "About": "AQ-TLC v1.0 — Advanced Quantitative TLC Analysis\nBy Giancarlo Pascali",
    },
)

# -- Hide Streamlit chrome -----------------------------------------------------
st.markdown(
    """
    <style>
        #MainMenu  { visibility: hidden; }
        footer     { visibility: hidden; }
        header     { visibility: hidden; }
        section[data-testid="stSidebar"] { display: none; }
        .block-container {
            padding: 0 !important;
            max-width: 100% !important;
        }
    </style>
    """,
    unsafe_allow_html=True,
)

# -- Declare the custom component ----------------------------------------------

_FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "frontend")
_component_func = components.declare_component("aq_tlc", path=_FRONTEND_DIR)

# -- Session state initialisation ----------------------------------------------

if "pending_response" not in st.session_state:
    st.session_state.pending_response = None
if "last_req_id" not in st.session_state:
    st.session_state.last_req_id = None

# -- Render the component ------------------------------------------------------

# Pass any pending response back to JS as component args.
# The component fills the full viewport height (Streamlit will honour the
# stSetHeight() calls from the JS side to keep the iframe sized correctly).
component_value = _component_func(
    response=st.session_state.pending_response,
    key="aq_tlc_main",
    default=None,
)

# -- Process incoming requests from JS ----------------------------------------

if component_value is not None:
    action     = component_value.get("action")
    req_id     = str(component_value.get("request_id", ""))
    payload    = component_value.get("payload", {})

    # Only process each request once (Streamlit reruns can deliver the same
    # component value more than once if no new stSend has been called).
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
            # Unknown action — clear any stale response
            st.session_state.pending_response = None

        # Rerun so the component re-renders with the new response in its args.
        st.rerun()

    else:
        # No new request — clear any pending response so it isn't re-applied
        # on subsequent natural reruns (e.g. from Streamlit's own polling).
        if component_value.get("action") != st.session_state.last_req_id:
            st.session_state.pending_response = None
