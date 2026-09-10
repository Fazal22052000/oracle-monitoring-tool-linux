# Alert.py – Oracle Alert Log Analyzer Pro (Enhanced UI with Mobile & Voice)
# Run: streamlit run Alert.py

import re
import os
import io
import time
import bisect
import zipfile
import traceback
import pandas as pd
import numpy as np
import streamlit as st
from datetime import datetime, timezone, timedelta, date, time as dtime
from dateutil import parser
import pandas.api.types as ptypes
import streamlit.components.v1 as components

# Optional: Mistral AI client
try:
    from mistralai import Mistral
except Exception:
    Mistral = None

# ---------------- Config ----------------
LOCAL_TZ = timezone(timedelta(hours=5, minutes=30))  # IST +05:30
MAX_PROMPT_CHARS = 9000

st.set_page_config(
    page_title="Oracle Alert Log Analyzer",
    layout="wide",
    initial_sidebar_state="collapsed",
    menu_items={
        'About': "Oracle Alert Log Analyzer Pro - Advanced diagnostic tool for DBAs"
    }
)

# ---------------- Initialize Session State ----------------
if "voice_enabled" not in st.session_state:
    st.session_state.voice_enabled = False
if "voice_command" not in st.session_state:
    st.session_state.voice_command = ""
if "voice_action" not in st.session_state:
    st.session_state.voice_action = None
if "last_voice_command" not in st.session_state:
    st.session_state.last_voice_command = ""

# ---------------- Theme / Mobile View (sidebar removed, fixed defaults) ----------------
theme_choice = "Light Mode"
mobile_view = False

if theme_choice == "Dark Mode":
    DARK_CSS = """
    <style>

        /* ===== Base Background (Dark) ===== */
        html, body, .main {
            background-color: #121212 !important;
            color: #E0E0E0 !important;
        }

        /* ===== Headers ===== */
        h1, h2, h3, h4, h5, h6 {
            color: #FFFFFF !important;
            font-weight: 600 !important;
        }

        /* ===== Components (Cards, Expanders, Dataframes etc.) ===== */
        .stExpander, .stDataFrame, .stAlert,
        .stTextInput, .stTextArea,
        .stSelectbox, .stRadio, .stFileUploader, .stTabs {
            background: #1E1E1E !important;
            border-radius: 10px !important;
            border: 1px solid #2A2A2A !important;
            color: #E0E0E0 !important;
            box-shadow: 0 2px 6px rgba(0,0,0,0.6) !important;
        }

        /* ===== File Uploader ===== */
        [data-testid="stFileUploaderDropzone"] {
            background: #1A1A1A !important;
            border: 2px dashed #333 !important;
            border-radius: 10px !important;
        }
        [data-testid="stFileUploaderDropzone"] p,
        [data-testid="stFileUploaderDropzone"] span {
            color: #CCCCCC !important;
        }

        /* ===== Buttons ===== */
        .stButton > button {
            background: #2F3B52 !important;
            color: #FFFFFF !important;
            border: 1px solid #3F4B67 !important;
            border-radius: 6px !important;
            padding: 0.5rem 1.5rem !important;
            font-weight: 600 !important;
            transition: 0.2s ease-in-out !important;
        }
        .stButton > button:hover {
            background: #3D4A66 !important;
            transform: translateY(-2px);
            box-shadow: 0 4px 10px rgba(0,0,0,0.7);
        }

        /* ===== Download Button ===== */
        .stDownloadButton > button {
            background: #0059B2 !important;
            color: white !important;
            border-radius: 6px !important;
            border: none !important;
            font-weight: 600 !important;
        }
        .stDownloadButton > button:hover {
            background: #0073E5 !important;
        }

        /* ===== Tabs ===== */
        .stTabs [data-baseweb="tab"] {
            background: #1E1E1E !important;
            color: #B0B0B0 !important;
            border-radius: 8px 8px 0 0 !important;
            border: 1px solid #2A2A2A !important;
        }
        .stTabs [aria-selected="true"] {
            background: #2F3B52 !important;
            color: #FFF !important;
            border-bottom: 2px solid #4A90E2 !important;
        }

        /* ===== Metrics ===== */
        [data-testid="stMetricValue"] {
            color: #4A90E2 !important;
            font-weight: 700 !important;
        }

        /* ===== Links ===== */
        .stMarkdown a {
            color: #4A90E2 !important;
        }

        footer {
            color: #AAAAAA !important;
        }

    </style>
    """
    st.markdown(DARK_CSS, unsafe_allow_html=True)



# ---------------- Custom CSS for Enhanced Design ----------------
mobile_css = ""
if mobile_view:
    mobile_css = """
    <style>
        /* Mobile-Friendly Overrides */
        .main {
            padding: 0.5rem !important;
        }
        h1 {
            font-size: 1.8rem !important;
            padding: 0.5rem 0 !important;
        }
        h2, h3 {
            font-size: 1.3rem !important;
        }
        .stButton > button {
            width: 100% !important;
            padding: 0.8rem !important;
            font-size: 1.1rem !important;
        }
        .stMetric {
            background: white;
            padding: 1rem;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 0.5rem;
        }
        [data-testid="stMetricValue"] {
            font-size: 1.5rem !important;
        }
        .stExpander {
            margin-bottom: 0.8rem !important;
        }
        .dataframe {
            font-size: 0.85rem !important;
        }
        /* Touch-friendly spacing */
        .stRadio > div {
            padding: 0.8rem !important;
        }
        .stSelectbox, .stTextInput, .stTextArea {
            margin-bottom: 1rem !important;
        }
        /* Larger tap targets */
        [data-testid="stFileUploader"] {
            padding: 1.5rem !important;
        }
    </style>
    """

st.markdown(mobile_css + """
<style>
    .main {
        background: #121212 !important;
        padding: 2rem;
    }
    .stExpander {
        background: white;
        border-radius: 12px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        margin-bottom: 1.5rem;
        border: none;
    }
    h1 {
        color: white;
        font-weight: 700;
        text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        padding: 1rem 0;
        margin-bottom: 2rem;
    }
    h2, h3 {
        color: #667eea;
        font-weight: 600;
    }
    .dataframe {
        border-radius: 8px;
        overflow: hidden;
    }
    .stButton > button {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        border-radius: 8px;
        padding: 0.5rem 2rem;
        font-weight: 600;
        transition: all 0.3s ease;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .stButton > button:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
    }
    .stDownloadButton > button {
        background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        color: white;
        border: none;
        border-radius: 8px;
        padding: 0.5rem 2rem;
        font-weight: 600;
    }
    .stAlert {
        border-radius: 8px;
        border-left: 4px solid #667eea;
    }
    .stFileUploader {
        background: white;
        border-radius: 12px;
        padding: 2rem;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    [data-testid="stMetricValue"] {
        font-size: 2rem;
        font-weight: 700;
        color: #667eea;
    }
    .stTextInput > div > div > input,
    .stTextArea > div > div > textarea {
        border-radius: 8px;
        border: 2px solid #e0e0e0;
        transition: border-color 0.3s ease;
    }
    .stTextInput > div > div > input:focus,
    .stTextArea > div > div > textarea:focus {
        border-color: #667eea;
        box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
    }
    .stSelectbox > div > div {
        border-radius: 8px;
    }
    .stRadio > div {
        background: white;
        padding: 1rem;
        border-radius: 8px;
    }
    .stTabs [data-baseweb="tab-list"] {
        gap: 8px;
    }
    .stTabs [data-baseweb="tab"] {
        border-radius: 8px 8px 0 0;
        padding: 0.5rem 1.5rem;
        background: white;
    }
    .stTabs [aria-selected="true"] {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
    }
    .js-plotly-plot {
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
</style>
""", unsafe_allow_html=True)

# ---------------- Header Section ----------------
if mobile_view:
    # Determine header color based on theme
    header_color = "#000000" if theme_choice == "Light Mode" else "#ffffff"
    st.markdown(f"""
    <div style='text-align: center; padding: 1rem 0;'>
        <h1 style='font-size: 1.8rem; margin-bottom: 0.3rem; color: {header_color};'>🧠 Oracle Alert Analyzer</h1>
        <p style='color: {header_color}; font-size: 0.9rem; opacity: 0.9;'>Advanced DBA Tool</p>
    </div>
    """, unsafe_allow_html=True)
else:
    col1, col2, col3 = st.columns([1, 2, 1])
    with col2:
        st.markdown("""
        <div style='text-align: center; padding: 2rem 0;'>
            <h1 style='font-size: 3rem; margin-bottom: 0.5rem;'>🧠 Oracle Alert Log Analyzer</h1>
            <p style='color: white; font-size: 1.2rem; opacity: 0.9;'>Advanced Diagnostic Tool for DBAs</p>
        </div>
        """, unsafe_allow_html=True)


# ---------------- Regex & Helpers ----------------
TIMESTAMP_RE = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+(?:[\+\-]\d{2}:\d{2}))")
ORA_RE = re.compile(r"\bORA-(\d{3,5}):?\s*(.*)")
WARN_RE = re.compile(r"\bWARNING\b|\bWarning\b|\bwarning\b")
TRACE_RE = re.compile(r"(\/[\w\/\.\-\+]*\.trc)")
KILL_SESSION_RE = re.compile(r"KILL SESSION for sid=\((\d+),\s*(\d+)\)", re.IGNORECASE)

# Notable non-"WARNING"-worded events that real alert logs are full of but
# that WARN_RE alone misses because they never contain the literal word
# "WARNING". Combined into one regex (named groups) rather than several
# separate searches per line, since this runs against every line of what
# can be million-line alert logs.
#  - "Fatal NI connect error ..." / "TNS-nnnnn: ..." — listener/network
#    connection failures (e.g. TNS-12564 connection refused). These can be
#    the single most frequent event in a log when a remote listener is down,
#    so missing them entirely misrepresents how healthy the instance is.
#  - "Checkpoint not complete" / "cannot allocate new log" — redo log
#    switches stalling because the checkpoint (or archiver) hasn't kept up;
#    a classic, high-signal performance problem DBAs watch for.
#  - RAC / Data Guard / Flashback patterns below are based on well-documented,
#    standard Oracle alert log message text (consistent across 12c/19c/21c
#    per Oracle's own diagnostics documentation). The RAC patterns are
#    confirmed against a real node-eviction event found in this environment's
#    own log; Data Guard and Flashback are not (this environment doesn't
#    appear to be actively running either), so treat those two as a starting
#    point to correct if your actual wording differs.
#  - RMAN ("Control autobackup written to ...", RMAN-nnnnn error codes) and
#    Data Pump ("DM00"/"DW00" master/worker process start/stop, "Started
#    service SYS.KUPC$..." AQ queues) ARE confirmed against real matches in
#    this environment's log (a control-file autobackup and a scheduled
#    export job named FRSEXT.DAILY_BKUP_09082026).
NOTABLE_EVENT_RE = re.compile(
    r"(?P<tns>Fatal NI connect error\s+\d+|^\s*TNS-\d{4,5}\b)"
    r"|(?P<ckpt>Checkpoint not complete)"
    r"|(?P<logsw>cannot allocate new log)"
    # RAC: cluster reconfiguration, interconnect problems, node eviction —
    # all high-severity in a RAC environment even without an ORA- code.
    r"|(?P<rac>Reconfiguration (?:started|complete)|IPC Send timeout|"
    r"Global Resource Directory frozen|instance eviction|Evicted instance|"
    r"Waiting for instances to leave|Communications reconfiguration underway|"
    r"CLUSTER_INTERCONNECTS)"
    # Data Guard / redo transport: standby shipping/apply falling behind or
    # failing, which is exactly the kind of thing a DBA needs surfaced even
    # if the individual line has no ORA- code.
    r"|(?P<dg>\bRFS\[|\bFAL\[|Redo Shipping Client|Media Recovery (?:Log|Waiting for)|"
    r"Managed Standby Recovery|\bMRP0\b|redo transport)"
    # Flashback Database operations — restore points, flashback recovery.
    r"|(?P<flashback>Flashback Database|Flashback Restore|Flashback Media Recovery|"
    r"guaranteed restore point)"
    # RMAN: control file/spfile autobackups and RMAN- error codes.
    r"|(?P<rman>Control autobackup written to|RMAN-\d{4,5})"
    # Data Pump: master (DM) / worker (DW) process lifecycle and the AQ
    # command/status queues every expdp/impdp job starts.
    r"|(?P<datapump>\bD[MW]\d{2}\s+(?:started|stopped)\s+with\s+pid=|"
    r"Data Pump job|KUPC\$[CS]_)",
    re.I
)
NOTABLE_EVENT_LABELS = {
    "tns": "TNS/Listener", "ckpt": "Checkpoint Stall", "logsw": "Log Switch Stall",
    "rac": "RAC/Cluster", "dg": "Data Guard/Redo Transport", "flashback": "Flashback",
    "rman": "RMAN", "datapump": "Data Pump",
}

# "Fatal NI connect error ..." is always immediately followed by a
# "(DESCRIPTION=(ADDRESS=...)(CONNECT_DATA=(...)(SERVICE_NAME=X)(CID=(PROGRAM=Y)(HOST=Z)...))))"
# line naming the exact service and connecting client host — without this,
# thousands of near-identical "TNS/Listener" rows are indistinguishable even
# though they may span many different application services.
TNS_DESCRIPTOR_RE = re.compile(
    r"SERVICE_NAME=([^)]+)\).*?CID=\(PROGRAM=([^)]*)\)\(HOST=([^)]*)\)", re.I
)

# ---------------- Future-proofing catch-all ----------------
# Everything above is a fixed, hand-written list of known message shapes.
# That list will always lag behind reality — a new Oracle version, a
# component this app has never seen (Sharding, GoldenGate, TDE wallet
# errors, a brand-new RMAN/CRS code, etc.) can add messages tomorrow that
# none of the patterns above recognize, and those would otherwise be
# silently dropped with no way to know they exist.
#
# Rather than trying to keep hand-adding prefixes forever, this is a safety
# net that runs ONLY on lines nothing else already classified:
#  1. GENERIC_ERROR_CODE_RE — Oracle's "PREFIX-NNNNN" error code convention
#     (ORA-, TNS-, RMAN-, CRS-, PRVG-, PLS-, KUP-, LRM-, DIA-, GSM-, XAG-,
#     SP2-, ...) is extremely stable across products and versions even when
#     the *specific* codes are brand new — so matching the pattern itself,
#     not a fixed list of prefixes, catches future/unknown components for
#     free. ORA/TNS are excluded here since those already get dedicated,
#     richer handling above; this only fires for everything else.
#  2. GENERIC_SEVERITY_RE — a short list of high-signal, low-noise plain-
#     English phrases (deliberately NOT things like bare "abort"/"fail",
#     which produced real false positives earlier in this file) for
#     messages that don't use a coded format at all.
# Matches land in a separate "Unclassified / New Pattern" bucket rather than
# being folded into Warnings, so a DBA can scan specifically for "things
# this tool doesn't yet have a name for" without that diluting the accuracy
# of the named categories above.
_MONTH_ABBRS = {"JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"}
GENERIC_ERROR_CODE_RE = re.compile(r"\b([A-Z]{2,6}-\d{3,6})\b")
GENERIC_ERROR_CODE_SKIP_PREFIXES = {"ORA", "TNS"} | _MONTH_ABBRS
GENERIC_SEVERITY_RE = re.compile(
    r"\b(PANIC|OUT OF MEMORY|DISK FULL|NO SPACE LEFT|ACCESS DENIED|"
    r"PERMISSION DENIED|CORRUPT(?:ED|ION)?|UNRECOVERABLE|FATAL ERROR)\b", re.I
)

# ---------------- ASM-Specific Regex Patterns ----------------
ASM_LOG_MARKER_RE = re.compile(
    r"\bASM instance\b|\basm_diskgroups\s*=|\bDiskgroup used for Voting\b|"
    r"\bkfdp|\bASM client\b|remote asm mode|\+ASM\d*\b",
    re.I
)
ASM_MOUNT_RE = re.compile(r"SUCCESS:\s*diskgroup\s+(\S+)\s+was\s+mounted", re.I)
ASM_DISMOUNT_RE = re.compile(r"SUCCESS:\s*diskgroup\s+(\S+)\s+was\s+dismounted", re.I)
ASM_MOUNT_FAIL_RE = re.compile(r"ERROR:\s*diskgroup\s+(\S+)\s+was\s+not\s+mounted", re.I)
ASM_REBAL_START_RE = re.compile(
    r"NOTE:\s*starting rebalance of group\s+\d+/\S+\s*\(([^)]+)\)(?:\s*at power\s*(\d+))?", re.I
)
ASM_REBAL_COMPLETE_RE = re.compile(
    r"SUCCESS:\s*rebalance completed for group\s+\d+/\S+\s*\(([^)]+)\)", re.I
)
ASM_REBAL_INTERRUPT_RE = re.compile(
    r"NOTE:\s*rebalance interrupted for group\s+\d+/\S+\s*\(([^)]+)\)", re.I
)
ASM_DISK_ADD_RE = re.compile(
    r"SUCCESS:\s*ALTER DISKGROUP\s+(\S+)\s+ADD\s+.*?DISK\s+'([^']+)'", re.I
)
ASM_DISK_DROP_RE = re.compile(
    r"SUCCESS:\s*ALTER DISKGROUP\s+(\S+)\s+DROP\s+DISK", re.I
)
ASM_CLIENT_DISCONNECT_RE = re.compile(
    r"ASM client\s+(\S+)\s+disconnected", re.I
)
ASM_CLIENT_RECONNECT_RE = re.compile(
    r"client\s+(\S+).*?(?:has reconnected to|attempting to (?:re)?connect)", re.I
)
ASM_ERROR_RE = re.compile(r"^\s*ERROR:\s*(.*)", re.I)
# Fixed: was requiring whitespace right after "file", which missed plurals
# like "Voting files is:" and "voting file(s)." — now matches file/files with a word boundary.
ASM_VOTING_RE = re.compile(r"\bvoting files?\b", re.I)
# WARNING-level voting risk: diskgroup holding voting files isn't mounted (quorum risk)
ASM_VOTING_RISK_RE = re.compile(r"WARNING:.*voting files?.*not mounted", re.I)
# Instance crash / termination events — high-severity, previously not captured at all
ASM_TERM_INITIATED_RE = re.compile(
    r"^([\w()]+)\s*\(ospid:\s*([\w]+)\):\s*terminating the instance"
    r"(?:\s+due to ORA error\s+(\d+))?", re.I
)
ASM_TERM_COMPLETE_RE = re.compile(
    r"Instance terminated by\s+([\w()]+),\s*pid\s*=\s*([\w]+)", re.I
)
# Disk-level offline initiation (distinct from a whole diskgroup dismount)
ASM_DISK_OFFLINE_RE = re.compile(
    r"initiating offline of disk\s+(\S+)\s*\(([^)]+)\).*?\bgroup\s+\d+\s*\(([^)]+)\)", re.I
)
# --- Patterns added after validating against a real ASM alert log ---
# A disk being marked for de-assignment often precedes it actually dropping
# out of the diskgroup — an early-warning storage signal that was
# completely uncaptured (3,600+ occurrences found in real validation).
ASM_DISK_DEASSIGN_RE = re.compile(
    r"NOTE:\s*Disk\s+(\S+)\s+in\s+mode\s+\S+\s+marked for de-assignment", re.I
)
# Grid Infrastructure / ASM cluster reconfiguration — same phrasing as the
# RAC pattern in the main DB alert-log parser, but ASM instances log their
# own reconfiguration events independently of the RDBMS instances.
ASM_RECONFIG_RE = re.compile(r"Reconfiguration (?:started|complete)", re.I)
# A background/OS process being killed — found correlating with repeated
# instance terminations in real validation (OS-level resource exhaustion).
ASM_PROC_TERM_REQ_RE = re.compile(r"Process termination requested for pid\s+(\d+)", re.I)
# Diskgroup name embedded in an ORA- message body (e.g. diskgroup "FRA_FRS"
# space exhausted) so ASM ORA errors can be attributed to a diskgroup like
# every other ASM event, instead of just showing the raw error text.
ASM_ORA_DISKGROUP_NAME_RE = re.compile(r'diskgroup\s+"?([A-Za-z0-9_$]+)"?', re.I)

def extract_zip_uploaded_file(uploaded_zip):
    extracted_files = {}
    with zipfile.ZipFile(uploaded_zip) as z:
        for file_name in z.namelist():
            if file_name.lower().endswith((".log", ".txt")):
                extracted_files[file_name] = (
                    z.open(file_name)
                    .read()
                    .decode("utf-8", errors="ignore")
                    .splitlines()
                )
    return extracted_files

def lines_from_uploaded_file(f):
    raw = f.read().decode("utf-8", errors="ignore")
    return raw.splitlines()

def analyze_alert_log_lines(lines, source_name="uploaded"):
    ora_errors = []
    warnings = []
    kill_sessions = []
    unclassified_events = []
    current_timestamp = None

    trace_locations = [(i, TRACE_RE.search(line).group(1)) for i, line in enumerate(lines) if TRACE_RE.search(line)]
    _trace_idxs = [t_idx for t_idx, _ in trace_locations]

    # Effective "current timestamp" as of each line, so any .trc reference
    # found anywhere in the file can be timestamped for the dedicated
    # Trace Files section, independent of the ORA/warning/kill-session scan
    # below (which only advances current_timestamp on pure timestamp lines).
    line_timestamps = [None] * len(lines)
    _running_ts = None
    for _i, _raw in enumerate(lines):
        _line = _raw.rstrip("\n")
        if _line.strip():
            _ts_m = TIMESTAMP_RE.search(_line)
            if _ts_m:
                _running_ts = _ts_m.group(1)
        line_timestamps[_i] = _running_ts

    trace_files = [
        {
            "Timestamp": line_timestamps[t_idx] or "Not Found",
            "Trace File": t_path,
            "Source": source_name,
            "Raw Line": lines[t_idx].rstrip("\n").strip(),
        }
        for t_idx, t_path in trace_locations
    ]

    # How many lines away a trace reference is still allowed to count as
    # "belonging" to an error. Real alert logs interleave several
    # timestamp-only lines and unrelated event lines between an ORA- error
    # and its "Errors in file .../xxx.trc" or "Refer trace file ... .trc"
    # reference, so a tight 5-line window (the old behavior) missed a large
    # fraction of real associations and reported "Not Found" even though a
    # trace file was clearly present nearby in the log.
    NEAR_WINDOW = 3       # highest-confidence: line immediately before/after
    WIDE_WINDOW = 25      # fallback: closest trace reference in this range

    def find_nearby_trace(idx):
        if not trace_locations:
            return "Not Found"

        # Binary-search for the trace reference(s) closest to idx instead of
        # scanning the full list for every error (important for large logs
        # with many .trc mentions).
        pos = bisect.bisect_left(_trace_idxs, idx)
        candidates = []
        if pos < len(trace_locations):
            candidates.append(trace_locations[pos])
        if pos > 0:
            candidates.append(trace_locations[pos - 1])

        # 1) Highest confidence: a trace reference within a tight window.
        #    Oracle almost always writes "Errors in file .../xxx.trc
        #    (incident=NN):" on the line immediately BEFORE the ORA- line,
        #    so prefer a look-behind match, then look-ahead.
        near = [(abs(t_idx - idx), t_idx, t_path) for t_idx, t_path in candidates if abs(t_idx - idx) <= NEAR_WINDOW]
        if near:
            near.sort(key=lambda x: x[0])
            return near[0][2]

        # 2) Fallback: widen the search so references that appear a bit
        #    further away (e.g. "Refer trace file ... for details" logged
        #    a few events later) are still picked up, rather than defaulting
        #    to "Not Found" whenever the reference isn't right next door.
        best_path, best_dist = None, None
        for t_idx, t_path in candidates:
            dist = abs(t_idx - idx)
            if dist <= WIDE_WINDOW and (best_dist is None or dist < best_dist):
                best_path, best_dist = t_path, dist
        return best_path if best_path else "Not Found"
    
    def extract_kill_session_details(start_idx, lines):
        """Extract detailed information from KILL SESSION block - OPTIMIZED"""
        details = {
            "reason": "Not Found",
            "mode": "Not Found",
            "requestor": "Not Found",
            "owner": "Not Found",
            "result": "Not Found",
            "full_block": []
        }
        
        # Look ahead up to 10 lines for details
        end_range = min(start_idx + 10, len(lines))
        for j in range(start_idx, end_range):
            line = lines[j]
            details["full_block"].append(line)
            
            line_stripped = line.strip()
            
            if "Reason =" in line_stripped:
                details["reason"] = line_stripped.split("Reason =", 1)[1].strip()
            elif "Mode =" in line_stripped:
                details["mode"] = line_stripped.split("Mode =", 1)[1].strip()
            elif "Requestor =" in line_stripped:
                details["requestor"] = line_stripped.split("Requestor =", 1)[1].strip()
            elif "Owner =" in line_stripped:
                details["owner"] = line_stripped.split("Owner =", 1)[1].strip()
            elif "Result =" in line_stripped:
                details["result"] = line_stripped.split("Result =", 1)[1].strip()
            
            # Stop early if we hit another timestamp or KILL SESSION
            if j > start_idx and (TIMESTAMP_RE.search(line_stripped) or KILL_SESSION_RE.search(line_stripped)):
                break
        
        return details

    for i, raw in enumerate(lines):
        line = raw.rstrip("\n")
        if not line.strip():
            continue

        ts_m = TIMESTAMP_RE.search(line)
        if ts_m:
            current_timestamp = ts_m.group(1)
            continue

        # Check for KILL SESSION event
        kill_m = KILL_SESSION_RE.search(line)
        if kill_m:
            sid = kill_m.group(1)
            serial = kill_m.group(2)
            details = extract_kill_session_details(i, lines)
            
            kill_sessions.append({
                "Timestamp": current_timestamp or "Not Found",
                "SID": sid,
                "Serial#": serial,
                "Reason": details["reason"],
                "Mode": details["mode"],
                "Requestor": details["requestor"],
                "Owner": details["owner"],
                "Result": details["result"],
                "Trace File": find_nearby_trace(i),
                "Source": source_name,
                "Raw Line": line,
                "Full Block": "\n".join(details["full_block"])
            })
            continue

        ora_m = ORA_RE.search(line)
        if ora_m:
            code = f"ORA-{ora_m.group(1)}"
            if code not in {"ORA-0"}:
                ora_errors.append({
                    "Timestamp": current_timestamp or "Not Found",
                    "ORA Error": code,
                    "Trace File": find_nearby_trace(i),
                    "Source": source_name,
                    "Raw Line": line,
                    "_line_idx": i,
                })
        # Independent check (not elif): a line can legitimately be BOTH a
        # WARNING and contain an ORA- code, e.g.
        # "WARNING: inbound connection timed out (ORA-3136)". Previously
        # such lines were only ever recorded as an ORA error and silently
        # dropped from the Warnings table.
        matched_warning = False
        if WARN_RE.search(line):
            warnings.append({
                "Timestamp": current_timestamp or "Not Found",
                "Category": "General",
                "Warning Message": line.strip(),
                "Trace File": find_nearby_trace(i),
                "Source": source_name,
                "Raw Line": line,
            })
            matched_warning = True

        # Notable events that never contain the literal word "WARNING" (TNS
        # listener failures, checkpoint/log-switch stalls) but are just as
        # operationally significant — see NOTABLE_EVENT_RE above.
        matched_notable = False
        if not matched_warning:
            notable_m = NOTABLE_EVENT_RE.search(line)
            if notable_m:
                matched_notable = True
                label = NOTABLE_EVENT_LABELS[notable_m.lastgroup]
                msg = line.strip()
                # "Fatal NI connect error ..." is immediately followed by the
                # DESCRIPTION= connect descriptor naming the actual service
                # and client host involved — pull that in so, e.g., 43,000
                # near-identical TNS/Listener rows aren't indistinguishable
                # from each other when they actually span multiple services.
                if notable_m.lastgroup == "tns" and i + 1 < len(lines):
                    desc_m = TNS_DESCRIPTOR_RE.search(lines[i + 1])
                    if desc_m:
                        service, _program, client_host = desc_m.groups()
                        msg += f"  [Service: {service.strip()}, Client Host: {client_host.strip()}]"
                warnings.append({
                    "Timestamp": current_timestamp or "Not Found",
                    "Category": label,
                    "Warning Message": msg,
                    "Trace File": find_nearby_trace(i),
                    "Source": source_name,
                    "Raw Line": line,
                })

        # Future-proofing safety net — see GENERIC_ERROR_CODE_RE /
        # GENERIC_SEVERITY_RE above. Runs ONLY on lines nothing above
        # already recognized, so it can never duplicate an existing row; it
        # only ever adds coverage for things this tool doesn't have a name
        # for yet (new Oracle versions/components, brand-new error codes).
        if not (ora_m or matched_warning or matched_notable):
            code_m = GENERIC_ERROR_CODE_RE.search(line)
            if code_m and code_m.group(1).split("-")[0] not in GENERIC_ERROR_CODE_SKIP_PREFIXES:
                unclassified_events.append({
                    "Timestamp": current_timestamp or "Not Found",
                    "Match Type": "Unmapped Error Code",
                    "Matched": code_m.group(1),
                    "Trace File": find_nearby_trace(i),
                    "Source": source_name,
                    "Raw Line": line.strip(),
                })
            else:
                sev_m = GENERIC_SEVERITY_RE.search(line)
                if sev_m:
                    unclassified_events.append({
                        "Timestamp": current_timestamp or "Not Found",
                        "Match Type": "Possible Severity Keyword",
                        "Matched": sev_m.group(1).upper(),
                        "Trace File": find_nearby_trace(i),
                        "Source": source_name,
                        "Raw Line": line.strip(),
                    })

    # ---- Group consecutive ORA- lines into logical error blocks ----
    # Oracle commonly writes a root error immediately followed by chained /
    # PL-SQL call-stack ORA- lines (e.g. an ORA-12012 job failure followed by
    # ORA-03150, ORA-02063, ORA-06512 stack lines). A DBA reading the raw log
    # sees these as ONE incident. Rows whose line indices are separated only
    # by blank or timestamp-only lines are grouped into the same block so the
    # full incident context is preserved, while each ORA code still gets its
    # own row (so counts/filters/exports are unaffected).
    if ora_errors:
        blocks = []
        current_block = [0]
        for k in range(1, len(ora_errors)):
            prev_idx = ora_errors[k - 1]["_line_idx"]
            this_idx = ora_errors[k]["_line_idx"]
            between_ok = True
            for li in range(prev_idx + 1, this_idx):
                content = lines[li].rstrip("\n").strip()
                if content and not TIMESTAMP_RE.search(content):
                    between_ok = False
                    break
            if between_ok:
                current_block.append(k)
            else:
                blocks.append(current_block)
                current_block = [k]
        blocks.append(current_block)

        for b_num, blk in enumerate(blocks, start=1):
            block_raw_lines = [ora_errors[k]["Raw Line"] for k in blk]
            block_codes = [ora_errors[k]["ORA Error"] for k in blk]
            full_block_text = "\n".join(block_raw_lines)
            for k in blk:
                ora_errors[k]["Error Block ID"] = f"{source_name}-B{b_num}"
                ora_errors[k]["Full Error Block"] = full_block_text
                seen = set()
                related_unique = [c for c in block_codes if c != ora_errors[k]["ORA Error"] and not (c in seen or seen.add(c))]
                ora_errors[k]["Related ORA Codes"] = ", ".join(related_unique) if related_unique else "-"

        for e in ora_errors:
            e.pop("_line_idx", None)

    return ora_errors, warnings, kill_sessions, trace_files, unclassified_events

def is_asm_log(lines, sample_size=500):
    """Heuristically detect whether a set of log lines belongs to an ASM
    (Automatic Storage Management) instance rather than a regular RDBMS
    alert log, by scanning for ASM-specific markers."""
    checked = 0
    for line in lines:
        if ASM_LOG_MARKER_RE.search(line):
            return True
        checked += 1
        if checked >= sample_size:
            break
    return False

def analyze_asm_events(lines, source_name="uploaded"):
    """Parse ASM alert log lines for diskgroup mount/dismount events,
    rebalance operations, disk add/drop activity, client connect/disconnect
    events, voting file activity, ORA- errors, and ASM-specific ERROR: lines."""
    events = []
    unclassified_events = []
    current_timestamp = None

    # Same trace-file association logic as the main DB alert-log parser —
    # ASM ORA- errors (e.g. ORA-15041 diskgroup space exhausted) are
    # frequently preceded by "Errors in file .../xxx.trc:" just like RDBMS
    # errors are, and that association was previously only built for the
    # regular alert-log parser, never for ASM logs.
    trace_locations = [(i, TRACE_RE.search(line).group(1)) for i, line in enumerate(lines) if TRACE_RE.search(line)]
    _trace_idxs = [t_idx for t_idx, _ in trace_locations]
    NEAR_WINDOW = 3
    WIDE_WINDOW = 25

    def find_nearby_trace(idx):
        if not trace_locations:
            return "Not Found"
        pos = bisect.bisect_left(_trace_idxs, idx)
        candidates = []
        if pos < len(trace_locations):
            candidates.append(trace_locations[pos])
        if pos > 0:
            candidates.append(trace_locations[pos - 1])
        near = [(abs(t_idx - idx), t_idx, t_path) for t_idx, t_path in candidates if abs(t_idx - idx) <= NEAR_WINDOW]
        if near:
            near.sort(key=lambda x: x[0])
            return near[0][2]
        best_path, best_dist = None, None
        for t_idx, t_path in candidates:
            dist = abs(t_idx - idx)
            if dist <= WIDE_WINDOW and (best_dist is None or dist < best_dist):
                best_path, best_dist = t_path, dist
        return best_path if best_path else "Not Found"

    for i, raw_line in enumerate(lines):
        line = raw_line.rstrip("\n")
        if not line.strip():
            continue

        ts_m = TIMESTAMP_RE.search(line)
        if ts_m:
            current_timestamp = ts_m.group(1)
            continue

        ts_now = current_timestamp or "Not Found"

        # --- Instance crash / termination (highest severity, check first) ---
        m = ASM_TERM_INITIATED_RE.search(line)
        if m:
            reason = f" — ORA error {m.group(3)}" if m.group(3) else ""
            events.append({"Timestamp": ts_now, "Event Type": "Instance Termination Initiated",
                            "Diskgroup": "-", "Detail": f"By {m.group(1)} (ospid {m.group(2)}){reason}",
                            "Source": source_name, "Raw Line": line})
            continue

        # ORA- errors — previously not checked for at all in ASM logs. Real
        # validation found ORA-15041 (diskgroup space exhausted) 149 times
        # and ORA-00600 (internal error) in this environment's own ASM log,
        # both completely invisible before this check existed.
        ora_m = ORA_RE.search(line)
        if ora_m:
            code = f"ORA-{ora_m.group(1)}"
            dg_m = ASM_ORA_DISKGROUP_NAME_RE.search(line)
            events.append({"Timestamp": ts_now, "Event Type": "ORA Error",
                            "Diskgroup": dg_m.group(1) if dg_m else "-",
                            "Detail": f"{code}: {ora_m.group(2).strip()}" if ora_m.group(2) else line.strip(),
                            "Trace File": find_nearby_trace(i),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_DISK_DEASSIGN_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Disk De-assignment",
                            "Diskgroup": "-", "Detail": f"Disk {m.group(1)} marked for de-assignment",
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_RECONFIG_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Cluster Reconfiguration",
                            "Diskgroup": "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_PROC_TERM_REQ_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Process Termination Requested",
                            "Diskgroup": "-", "Detail": f"pid {m.group(1)}",
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_TERM_COMPLETE_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Instance Terminated",
                            "Diskgroup": "-", "Detail": f"By {m.group(1)}, pid={m.group(2)}",
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_MOUNT_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Diskgroup Mounted",
                            "Diskgroup": m.group(1), "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_DISMOUNT_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Diskgroup Dismounted",
                            "Diskgroup": m.group(1), "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_MOUNT_FAIL_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Diskgroup Mount Failed",
                            "Diskgroup": m.group(1), "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_REBAL_START_RE.search(line)
        if m:
            power = f" (power {m.group(2)})" if m.group(2) else ""
            events.append({"Timestamp": ts_now, "Event Type": "Rebalance Started",
                            "Diskgroup": m.group(1), "Detail": f"{line.strip()}{power}",
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_REBAL_COMPLETE_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Rebalance Completed",
                            "Diskgroup": m.group(1), "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_REBAL_INTERRUPT_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Rebalance Interrupted",
                            "Diskgroup": m.group(1), "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_DISK_ADD_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Disk Added",
                            "Diskgroup": m.group(1), "Detail": m.group(2),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_DISK_DROP_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Disk Dropped",
                            "Diskgroup": m.group(1), "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_DISK_OFFLINE_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Disk Offline Initiated",
                            "Diskgroup": m.group(3), "Detail": f"Disk {m.group(2)} ({m.group(1)})",
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_CLIENT_DISCONNECT_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Client Disconnected",
                            "Diskgroup": "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_CLIENT_RECONNECT_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Client Reconnected",
                            "Diskgroup": "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_VOTING_RISK_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Voting File At Risk",
                            "Diskgroup": "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_VOTING_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Voting File Activity",
                            "Diskgroup": "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_ERROR_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "ASM Error",
                            "Diskgroup": "-", "Detail": m.group(1).strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        # Future-proofing safety net — same as the main alert-log parser
        # (see GENERIC_ERROR_CODE_RE / GENERIC_SEVERITY_RE above). Only
        # reached when none of the ASM-specific patterns above matched, so
        # it never duplicates an existing row; it exists purely to catch
        # ASM message types this tool doesn't have a dedicated rule for yet
        # (e.g. a future ASM/CRS/GPnP feature or error code).
        code_m = GENERIC_ERROR_CODE_RE.search(line)
        if code_m and code_m.group(1).split("-")[0] not in GENERIC_ERROR_CODE_SKIP_PREFIXES:
            unclassified_events.append({
                "Timestamp": ts_now,
                "Match Type": "Unmapped Error Code",
                "Matched": code_m.group(1),
                "Source": source_name,
                "Raw Line": line.strip(),
            })
            continue

        sev_m = GENERIC_SEVERITY_RE.search(line)
        if sev_m:
            unclassified_events.append({
                "Timestamp": ts_now,
                "Match Type": "Possible Severity Keyword",
                "Matched": sev_m.group(1).upper(),
                "Source": source_name,
                "Raw Line": line.strip(),
            })

    return events, unclassified_events

def parse_iso_timestamp(ts):
    if not ts or ts == "Not Found":
        return None
    try:
        dt = parser.isoparse(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=LOCAL_TZ)
        return dt
    except Exception:
        try:
            dt = parser.parse(ts, fuzzy=True)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=LOCAL_TZ)
            return dt
        except Exception:
            return None


def detect_instance_summary_and_events(all_lines):
    """
    Scans a list of raw log lines and extracts instance names, hostnames,
    releases, startup events, shutdown events, crash events,
    ALTER commands, and RESIZE commands.
    """

    info = {
        "Instance Names": set(),
        "Hostnames": set(),
        "Oracle Releases": set(),
        "Startup Events": [],
        "Shutdown Events": [],
        "Crash Events": [],
        "Alter Commands": [],
        "Resize Commands": []        # ⭐ NEW
    }

    release_re = re.compile(r"(Release\s+\d+(?:\.\d+)*)", re.I)
    start_re = re.compile(r"(Starting\s+ORACLE\s+instance|PMON has started|Starting up ORACLE)", re.I)
    shutdown_re = re.compile(r"(Shutting down|shutdown\s+complete|Shutdown\s+normal|shutdown complete|ORACLE instance shut down)", re.I)
    # NOTE: deliberately does NOT match bare "abort" or "ORA-609" — those
    # match the extremely common, completely benign line
    # "opiodr aborting process unknown ospid (nnnn) as a result of ORA-609",
    # which fires on routine client disconnects/timeouts, not crashes. Using
    # them here would flag that as a "Crash Event" on almost every
    # production log and bury the real ones under noise.
    crash_re = re.compile(
        r"(Instance terminated|terminated abnormally|core dump|ORA-00600|ORA-07445|ORA-00603"
        r"|terminating the instance|Instance terminated by|System state dump|"
        r"LMON received an instance eviction|Evicted instance)",
        re.I
    )
    inst_re = re.compile(r"Instance\s+name[:\s]*([A-Za-z0-9_\-\.]+)", re.I)
    # Negative lookbehind excludes "(HOST=...)" as it appears inside TNS
    # connect descriptors — e.g. "(ADDRESS=(PROTOCOL=TCP)(HOST=10.52.18.12)...)"
    # or "(CID=(PROGRAM=oracle)(HOST=chfrsdb01)...)" — which are listener/
    # client addresses, not the database server's own hostname, and were
    # previously polluting this field with random client IPs.
    host_re = re.compile(r"(?:(?<!\()Host\s*[:=]\s*|Node name:\s*)([A-Za-z0-9\-\._]+)", re.I)

    # ⭐ NEW: Detect ANY ALTER command
    alter_re = re.compile(r"\bALTER\s+[A-Z_]+\b", re.I)

    # ⭐ NEW: Detect ANY RESIZE command
    resize_re = re.compile(r"\bRESIZE\b", re.I)

    ts_re = TIMESTAMP_RE
    last_ts = None  # store last timestamp

    for idx, line in enumerate(all_lines):
        text = line.rstrip("\n")

        # Timestamp detection
        ts_match = ts_re.search(text)
        if ts_match:
            last_ts = ts_match.group(1)

        # instance / release / host detection
        rel = release_re.search(text)
        if rel:
            info["Oracle Releases"].add(rel.group(1))

        inst = inst_re.search(text)
        if inst:
            info["Instance Names"].add(inst.group(1))

        host = host_re.search(text)
        if host:
            info["Hostnames"].add(host.group(1))

        # ⭐ NEW: Detect ALTER commands
        if alter_re.search(text):
            info["Alter Commands"].append({
                "Timestamp": last_ts or "Not Found",
                "Line": text.strip(),
                "Index": idx
            })
            continue

        # ⭐ NEW: Detect RESIZE commands
        if resize_re.search(text):
            info["Resize Commands"].append({
                "Timestamp": last_ts or "Not Found",
                "Line": text.strip(),
                "Index": idx
            })
            continue

        # Startup event
        if start_re.search(text):
            info["Startup Events"].append({
                "Timestamp": last_ts or "Not Found",
                "Line": text.strip(),
                "Index": idx
            })
            continue

        # Shutdown event
        if shutdown_re.search(text):
            info["Shutdown Events"].append({
                "Timestamp": last_ts or "Not Found",
                "Line": text.strip(),
                "Index": idx
            })
            continue

        # Crash event
        if crash_re.search(text):
            info["Crash Events"].append({
                "Timestamp": last_ts or "Not Found",
                "Line": text.strip(),
                "Index": idx
            })
            continue

    # Convert sets to sorted lists
    for k in ["Instance Names", "Hostnames", "Oracle Releases"]:
        info[k] = sorted(info[k])

    return info

# ---------------- Compare Two Parsed Lists ----------------
def compare_two_parsed_lists(list_a, list_b):
    """
    Compare two parsed alert log lists (ORA errors, warnings, kill sessions).
    list_a and list_b should be lists of dictionaries.

    Returns:
        {
            "counts": DataFrame comparing count of ORA errors,
            "new_in_b": items that exist only in B,
            "new_in_a": items that exist only in A
        }
    """
    import pandas as pd

    # Convert lists to DataFrame
    df_a = pd.DataFrame(list_a)
    df_b = pd.DataFrame(list_b)

    # ---- Compare ORA counts ----
    if "ORA Error" in df_a.columns and "ORA Error" in df_b.columns:
        counts_a = df_a["ORA Error"].value_counts().rename("Count_A")
        counts_b = df_b["ORA Error"].value_counts().rename("Count_B")
        counts = pd.concat([counts_a, counts_b], axis=1).fillna(0).astype(int)
    else:
        counts = pd.DataFrame()

    # ---- Unique in B (new) ----
    df_a_keys = df_a.astype(str).agg("|".join, axis=1).tolist()
    df_b_keys = df_b.astype(str).agg("|".join, axis=1).tolist()

    new_in_b = [b for bkey, b in zip(df_b_keys, list_b) if bkey not in df_a_keys]

    # ---- Unique in A (missing in B) ----
    new_in_a = [a for akey, a in zip(df_a_keys, list_a) if akey not in df_b_keys]

    return {
        "counts": counts.reset_index().rename(columns={"index": "ORA Error"}),
        "new_in_b": new_in_b,
        "new_in_a": new_in_a
    }


# ---------------- Mistral AI Section ----------------
def ai_generate(prompt: str) -> str:
    try:
        api_key = os.getenv("MISTRAL_API_KEY")
        if not api_key:
            return "⚠️ AI Error: MISTRAL_API_KEY not found in environment."
        if Mistral is None:
            return "⚠️ Mistral client not installed."

        client = Mistral(api_key=api_key)
        messages = [
            {
                "role": "system",
                "content": (
                    "You are an Oracle DBA expert. Analyze ONLY the provided alert log text. "
                    "Do NOT invent or assume additional ORA errors not present in the provided logs. "
                    "If no ORA or warnings exist in the supplied segment, explicitly state that. "
                    "Provide a concise summary suitable for production DBAs (3–5 sentences)."
                ),
            },
            {"role": "user", "content": prompt},
        ]

        ai_summary = None
        for attempt in range(3):
            try:
                response = client.chat.complete(
                    model="mistral-large-latest",
                    messages=messages,
                    temperature=0.2,
                )
                ai_summary = response.choices[0].message.content.strip()
                break
            except Exception as e:
                msg = str(e)
                if any(x in msg.lower() for x in ["timeout", "connection", "reset", "429", "capacity", "10054"]):
                    if attempt < 2:
                        time.sleep(5 * (attempt + 1))
                        continue
                return f"⚠️ AI Error: {msg}"
        else:
            return "⚠️ Mistral API connection issue persisted."

        ora_codes = sorted(set(re.findall(r"\bORA-\d{3,5}\b", prompt)))
        if ora_codes:
            link_lines = ["\n\n### 🔗 Related Oracle Support Links"]
            for code in ora_codes:
                google_link = f"https://www.google.com/search?q={code}+site:support.oracle.com"
                link_lines.append(f"- **{code}** → [Oracle Support]({google_link})")
            ora_links_block = "\n".join(link_lines)
        else:
            ora_links_block = ""
        
        ai_note = (
            "\n\n"
            "**⚠️ Note:** Since the recommendations are generated through AI-based analysis, they may not always be fully accurate. For validation and further details, please refer to the official Oracle Support documentation and knowledge base articles linked below."
        )

        return f"### 🧠 AI Summary\n{ai_summary}{ai_note}{ora_links_block}"

    except Exception as e:
        return f"⚠️ AI Error: {str(e)}"

# ---------------- File Upload Section ----------------
st.markdown("""
<div style='background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); margin-bottom: 2rem;'>
    <h3 style='margin-top: 0; color: #667eea;'>📂 Upload Alert Log Files</h3>
    <p style='color: #666; margin-bottom: 1rem;'>Select one or more Oracle RDBMS alert logs and/or ASM (+ASM) alert logs to analyze — ASM logs are auto-detected</p>
</div>
""", unsafe_allow_html=True)

uploaded_files = st.file_uploader("Upload Alert Log Files", type=["log","txt","zip"], accept_multiple_files=True, label_visibility="collapsed")

if not uploaded_files:
    st.markdown("""
    <div style='background: white; padding: 3rem; border-radius: 12px; text-align: center; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);'>
        <h2 style='color: #667eea; margin-bottom: 1rem;'>👋 Welcome!</h2>
        <p style='font-size: 1.1rem; color: #666;'>Upload your Oracle RDBMS and/or ASM alert log files above to begin analysis</p>
        <p style='color: #999; margin-top: 1rem;'>Supports .log and .txt files (RDBMS &amp; ASM alert logs, auto-detected) as well as .zip archives</p>
    </div>
    """, unsafe_allow_html=True)
    st.stop()

# Parse uploaded files
all_raw_lines = []
per_file_lines = {}
combined_ora = []
combined_warnings = []
combined_kill_sessions = []
combined_trace_files = []
combined_unclassified = []
combined_asm_events = []
asm_source_files = set()

with st.spinner("📄 Processing uploaded files..."):
    for f in uploaded_files:
        name = f.name

        # 🔥 ZIP FILE SUPPORT
        if name.lower().endswith(".zip"):
            extracted = extract_zip_uploaded_file(f)
            for zname, zlines in extracted.items():
                per_file_lines[zname] = zlines
                all_raw_lines.append(f"--- BEGIN FILE: {zname} ---")
                all_raw_lines.extend(zlines)
                all_raw_lines.append(f"--- END FILE: {zname} ---")

                o, w, k, tr, u = analyze_alert_log_lines(zlines, source_name=zname)
                combined_ora.extend(o)
                combined_warnings.extend(w)
                combined_kill_sessions.extend(k)
                combined_trace_files.extend(tr)
                combined_unclassified.extend(u)

                if is_asm_log(zlines):
                    asm_source_files.add(zname)
                    asm_events, asm_unclassified = analyze_asm_events(zlines, source_name=zname)
                    combined_asm_events.extend(asm_events)
                    combined_unclassified.extend(asm_unclassified)
            continue

        # Normal .log / .txt files
        lines = lines_from_uploaded_file(f)
        per_file_lines[name] = lines
        all_raw_lines.append(f"--- BEGIN FILE: {name} ---")
        all_raw_lines.extend(lines)
        all_raw_lines.append(f"--- END FILE: {name} ---")

        o, w, k, tr, u = analyze_alert_log_lines(lines, source_name=name)
        combined_ora.extend(o)
        combined_warnings.extend(w)
        combined_kill_sessions.extend(k)
        combined_trace_files.extend(tr)
        combined_unclassified.extend(u)

        # 💽 ASM Log Auto-Detection & Parsing
        if is_asm_log(lines):
            asm_source_files.add(name)
            asm_events, asm_unclassified = analyze_asm_events(lines, source_name=name)
            combined_asm_events.extend(asm_events)
            combined_unclassified.extend(asm_unclassified)


df_ora_all = pd.DataFrame(combined_ora) if combined_ora else pd.DataFrame(columns=["Timestamp","ORA Error","Trace File","Source","Raw Line","Error Block ID","Full Error Block","Related ORA Codes"])
df_warn_all = pd.DataFrame(combined_warnings) if combined_warnings else pd.DataFrame(columns=["Timestamp","Category","Warning Message","Trace File","Source","Raw Line"])
df_kill_all = pd.DataFrame(combined_kill_sessions) if combined_kill_sessions else pd.DataFrame(columns=["Timestamp","SID","Serial#","Reason","Mode","Requestor","Owner","Result","Trace File","Source","Raw Line","Full Block"])
df_asm_all = pd.DataFrame(combined_asm_events) if combined_asm_events else pd.DataFrame(columns=["Timestamp","Event Type","Diskgroup","Detail","Source","Raw Line"])
df_unclassified_all = pd.DataFrame(combined_unclassified) if combined_unclassified else pd.DataFrame(columns=["Timestamp","Match Type","Matched","Trace File","Source","Raw Line"])
df_trace_all = pd.DataFrame(combined_trace_files) if combined_trace_files else pd.DataFrame(columns=["Timestamp","Trace File","Source","Raw Line"])

if not df_ora_all.empty:
    df_ora_all["ParsedTimestamp"] = df_ora_all["Timestamp"].apply(parse_iso_timestamp)
else:
    df_ora_all["ParsedTimestamp"] = pd.Series(dtype="datetime64[ns]")

if not df_warn_all.empty:
    df_warn_all["ParsedTimestamp"] = df_warn_all["Timestamp"].apply(parse_iso_timestamp)
else:
    df_warn_all["ParsedTimestamp"] = pd.Series(dtype="datetime64[ns]")

if not df_kill_all.empty:
    df_kill_all["ParsedTimestamp"] = df_kill_all["Timestamp"].apply(parse_iso_timestamp)
else:
    df_kill_all["ParsedTimestamp"] = pd.Series(dtype="datetime64[ns]")

if not df_asm_all.empty:
    df_asm_all["ParsedTimestamp"] = df_asm_all["Timestamp"].apply(parse_iso_timestamp)
else:
    df_asm_all["ParsedTimestamp"] = pd.Series(dtype="datetime64[ns]")

if not df_unclassified_all.empty:
    df_unclassified_all["ParsedTimestamp"] = df_unclassified_all["Timestamp"].apply(parse_iso_timestamp)
else:
    df_unclassified_all["ParsedTimestamp"] = pd.Series(dtype="datetime64[ns]")

if not df_trace_all.empty:
    df_trace_all["ParsedTimestamp"] = df_trace_all["Timestamp"].apply(parse_iso_timestamp)
    df_trace_all = df_trace_all.sort_values("ParsedTimestamp", na_position="last").reset_index(drop=True)
else:
    df_trace_all["ParsedTimestamp"] = pd.Series(dtype="datetime64[ns]")

# ---------------- Quick Stats Dashboard ----------------
st.markdown("### 📊 Quick Statistics")

total_errors = len(combined_ora)
total_warnings = len(combined_warnings)
total_kills = len(combined_kill_sessions)
total_asm_events = len(combined_asm_events)
total_unclassified = len(combined_unclassified)

if asm_source_files:
    st.info(f"💽 **ASM log(s) detected:** {', '.join(sorted(asm_source_files))} — ASM diskgroup analysis is available below.")
    _term_types = {"Instance Termination Initiated", "Instance Terminated"}
    _term_total = sum(1 for e in combined_asm_events if e.get("Event Type") in _term_types)
    if _term_total > 0:
        st.error(f"🚨 **{_term_total} ASM instance crash/termination event(s) found** in the uploaded logs. See '💽 ASM Diskgroup Analysis → 🚨 Instance Health' below.")

    # ORA-15041 (diskgroup space exhausted) is one of the highest-impact,
    # most actionable things that can appear in an ASM log — flag it
    # specifically rather than letting it blend into the general ORA/ASM
    # error count, since space exhaustion needs immediate attention.
    _space_exhausted_total = sum(
        1 for e in combined_asm_events
        if e.get("Event Type") == "ORA Error" and "15041" in str(e.get("Detail", ""))
    )
    if _space_exhausted_total > 0:
        _dgs = sorted({
            e.get("Diskgroup") for e in combined_asm_events
            if e.get("Event Type") == "ORA Error" and "15041" in str(e.get("Detail", "")) and e.get("Diskgroup", "-") != "-"
        })
        _dg_txt = f" (diskgroup(s): {', '.join(_dgs)})" if _dgs else ""
        st.error(f"💾 **{_space_exhausted_total} diskgroup space-exhausted error(s) (ORA-15041)** found{_dg_txt} — see '💽 ASM Diskgroup Analysis → 🧨 ASM / ORA Errors' below.")

if total_unclassified > 0:
    st.warning(f"🆕 **{total_unclassified} line(s) didn't match any known pattern** — possibly a new/unfamiliar message type. See the '🆕 New/Unclassified' tab below to review.")

if mobile_view:
    # Mobile: Stack metrics vertically
    st.metric("📄 Files Uploaded", len(uploaded_files))
    st.metric("🔴 ORA Errors", total_errors)
    st.metric("🟡 Warnings", total_warnings)
    st.metric("⚡ Kill Sessions", total_kills)
    unique_ora = len(df_ora_all["ORA Error"].unique()) if not df_ora_all.empty else 0
    st.metric("🔢 Unique ORA Codes", unique_ora)
    st.metric("🆕 Unclassified", total_unclassified)
    if asm_source_files:
        st.metric("💽 ASM Events", total_asm_events)
else:
    # Desktop: Horizontal layout
    ncols = 7 if asm_source_files else 6
    cols = st.columns(ncols)
    with cols[0]:
        st.metric("📄 Files Uploaded", len(uploaded_files))
    with cols[1]:
        st.metric("🔴 ORA Errors", total_errors)
    with cols[2]:
        st.metric("🟡 Warnings", total_warnings)
    with cols[3]:
        st.metric("⚡ Kill Sessions", total_kills)
    with cols[4]:
        unique_ora = len(df_ora_all["ORA Error"].unique()) if not df_ora_all.empty else 0
        st.metric("🔢 Unique ORA Codes", unique_ora)
    with cols[5]:
        st.metric("🆕 Unclassified", total_unclassified)
    if asm_source_files:
        with cols[6]:
            st.metric("💽 ASM Events", total_asm_events)

st.markdown("---")

# ---------------- Global Filters ----------------
with st.expander("🔍 Filters & Search", expanded=False):
    tab1, tab2 = st.tabs(["📅 Date/Time Filter", "🔎 Keyword Search"])
    
    with tab1:
        today = date.today()
        if not df_ora_all.empty and df_ora_all["ParsedTimestamp"].notna().any():
            min_ts = df_ora_all["ParsedTimestamp"].min()
            max_ts = df_ora_all["ParsedTimestamp"].max()
            default_start = min_ts.astimezone(LOCAL_TZ).date()
            default_end = max_ts.astimezone(LOCAL_TZ).date()
        else:
            default_start = default_end = today

        col1, col2 = st.columns(2)
        with col1:
            global_start_date = st.date_input("Start date", default_start, key="global_start_date")
            global_start_time = st.time_input("Start time", dtime(0,0), key="global_start_time")
        with col2:
            global_end_date = st.date_input("End date", default_end, key="global_end_date")
            global_end_time = st.time_input("End time", dtime(23,59), key="global_end_time")

        global_start_dt = datetime.combine(global_start_date, global_start_time).replace(tzinfo=LOCAL_TZ)
        global_end_dt = datetime.combine(global_end_date, global_end_time).replace(tzinfo=LOCAL_TZ)
        st.info(f"📅 Filtering range: {global_start_dt} – {global_end_dt}")
    
    with tab2:
        search_q = st.text_input("🔎 Search ORA code, error text, trace path, source, or any keyword", "").strip()
        if search_q:
            st.info(f"🔎 Active search filter: **{search_q}**")

# Apply filters
def apply_global_date_filter(df, start_dt, end_dt):
    if df.empty or "ParsedTimestamp" not in df.columns:
        return df
    df = df[df["ParsedTimestamp"].notna()].copy()
    df = df[(df["ParsedTimestamp"] >= start_dt) & (df["ParsedTimestamp"] <= end_dt)]
    return df

if search_q:
    q = search_q.lower()
    df_ora_display = df_ora_all[df_ora_all.apply(lambda r:
        q in str(r.get("ORA Error","")).lower()
        or q in str(r.get("Trace File","")).lower()
        or q in str(r.get("Source","")).lower()
    , axis=1)].copy()
    df_warn_display = df_warn_all[df_warn_all.apply(lambda r:
        q in str(r.get("Warning Message","")).lower()
        or q in str(r.get("Category","")).lower()
        or q in str(r.get("Trace File","")).lower()
        or q in str(r.get("Source","")).lower()
    , axis=1)].copy()
    df_kill_display = df_kill_all[df_kill_all.apply(lambda r:
        q in str(r.get("SID","")).lower()
        or q in str(r.get("Serial#","")).lower()
        or q in str(r.get("Reason","")).lower()
        or q in str(r.get("Requestor","")).lower()
        or q in str(r.get("Owner","")).lower()
        or q in str(r.get("Source","")).lower()
    , axis=1)].copy()
    df_asm_display = df_asm_all[df_asm_all.apply(lambda r:
        q in str(r.get("Event Type","")).lower()
        or q in str(r.get("Diskgroup","")).lower()
        or q in str(r.get("Detail","")).lower()
        or q in str(r.get("Source","")).lower()
    , axis=1)].copy()
    df_unclassified_display = df_unclassified_all[df_unclassified_all.apply(lambda r:
        q in str(r.get("Match Type","")).lower()
        or q in str(r.get("Matched","")).lower()
        or q in str(r.get("Raw Line","")).lower()
        or q in str(r.get("Source","")).lower()
    , axis=1)].copy()
    df_trace_display = df_trace_all[df_trace_all.apply(lambda r:
        q in str(r.get("Trace File","")).lower()
        or q in str(r.get("Source","")).lower()
    , axis=1)].copy()
else:
    df_ora_display = df_ora_all.copy()
    df_warn_display = df_warn_all.copy()
    df_kill_display = df_kill_all.copy()
    df_asm_display = df_asm_all.copy()
    df_unclassified_display = df_unclassified_all.copy()
    df_trace_display = df_trace_all.copy()

df_ora_display = apply_global_date_filter(df_ora_display, global_start_dt, global_end_dt)
df_warn_display = apply_global_date_filter(df_warn_display, global_start_dt, global_end_dt)
df_kill_display = apply_global_date_filter(df_kill_display, global_start_dt, global_end_dt)
df_asm_display = apply_global_date_filter(df_asm_display, global_start_dt, global_end_dt)
df_unclassified_display = apply_global_date_filter(df_unclassified_display, global_start_dt, global_end_dt)
df_trace_display = apply_global_date_filter(df_trace_display, global_start_dt, global_end_dt)

# ---- APPLY GLOBAL FILTERS TO INSTANCE EVENTS ----
def filter_instance_events(event_list, search_q, start_dt, end_dt):
    """Filter instance-level events using global filters."""
    if not event_list:
        return pd.DataFrame(columns=["Timestamp", "Line"])

    df = pd.DataFrame(event_list)
    df["ParsedTimestamp"] = df["Timestamp"].apply(parse_iso_timestamp)

    # Apply date filter
    df = df[df["ParsedTimestamp"].notna()]
    df = df[(df["ParsedTimestamp"] >= start_dt) &
            (df["ParsedTimestamp"] <= end_dt)]

    # Apply keyword search
    if search_q:
        q = search_q.lower()
        df = df[df["Line"].str.lower().str.contains(q)]

    return df

# ---------------- Instance Summary & Events ----------------
expand_instance = st.session_state.get("voice_action") == "show_stats"
with st.expander("🗂️ Instance Summary & Events", expanded=expand_instance):

    # Build a clean list of raw lines from uploaded files (no wrapper markers)
    clean_lines = []
    for name, lines in per_file_lines.items():
        clean_lines.extend(lines)

    # Use the improved detector 
    info = detect_instance_summary_and_events(clean_lines)

    st.markdown("#### 🖥️ Instance Information")
    cols = st.columns(3)
    with cols[0]:
        st.info(f"**Instance Names**\n\n{', '.join(info['Instance Names']) or 'N/A'}")
    with cols[1]:
        st.info(f"**Hostnames**\n\n{', '.join(info['Hostnames']) or 'N/A'}")
    with cols[2]:
        st.info(f"**Oracle Releases**\n\n{', '.join(info['Oracle Releases']) or 'N/A'}")

    # ---------------- Startup Events ----------------
    st.markdown("#### 🚀 Startup Events")
    df = filter_instance_events(info["Startup Events"], search_q, global_start_dt, global_end_dt)
    if not df.empty:
        st.dataframe(df[["Timestamp", "Line"]], use_container_width=True)
    else:
        st.success("✅ No startup events in selected filters")

    # ---------------- Shutdown Events ----------------
    st.markdown("#### 🔻 Shutdown Events")
    df = filter_instance_events(info["Shutdown Events"], search_q, global_start_dt, global_end_dt)
    if not df.empty:
        st.dataframe(df[["Timestamp", "Line"]], use_container_width=True)
    else:
        st.success("✅ No shutdown events in selected filters")

    # ---------------- ALTER Command Events ----------------
    st.markdown("#### 📝 ALTER Command Events")
    df = filter_instance_events(info["Alter Commands"], search_q, global_start_dt, global_end_dt)
    if not df.empty:
        st.dataframe(df[["Timestamp", "Line"]], use_container_width=True)
    else:
        st.success("✅ No ALTER commands in selected filters")

    # ---------------- Resize Commands ----------------
    st.markdown("#### 📏 Resize Commands")
    df = filter_instance_events(info["Resize Commands"], search_q, global_start_dt, global_end_dt)
    if not df.empty:
        st.dataframe(df[["Timestamp", "Line"]], use_container_width=True)
    else:
        st.success("✅ No resize commands in selected filters")

    # ---------------- Crash / Termination Events ----------------
    st.markdown("#### 💥 Crash / Termination Events")
    df = filter_instance_events(info["Crash Events"], search_q, global_start_dt, global_end_dt)
    if not df.empty:
        st.dataframe(df[["Timestamp", "Line"]], use_container_width=True)
    else:
        st.success("🎉 No crash or abnormal termination events in selected filters")



# ---------------- ASM Diskgroup Analysis ----------------
if asm_source_files:
    expand_asm = st.session_state.get("voice_action") == "show_asm"
    with st.expander("💽 ASM Diskgroup Analysis", expanded=expand_asm):
        st.markdown("""
        <div style='background: linear-gradient(135deg, #43cea2 0%, #185a9d 100%);
                    padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
            <h4 style='margin: 0 0 0.5rem 0;'>💽 ASM Diskgroup Events</h4>
            <p style='margin: 0; opacity: 0.9;'>Mount/dismount activity, rebalance operations, disk changes & ASM errors</p>
        </div>
        """, unsafe_allow_html=True)

        if df_asm_display.empty:
            st.success("✅ No ASM diskgroup events found in selected range/search")
        else:
            # ---- ASM Quick Metrics ----
            type_counts = df_asm_display["Event Type"].value_counts()

            term_count = type_counts.get("Instance Termination Initiated", 0) + type_counts.get("Instance Terminated", 0)
            if term_count > 0:
                st.error(f"🚨 **{term_count} ASM instance termination event(s) detected** — check the Instance Health tab below immediately.")

            voting_risk_count = type_counts.get("Voting File At Risk", 0)
            if voting_risk_count > 0:
                st.warning(f"🗳️ **{voting_risk_count} voting-file quorum risk warning(s)** — a diskgroup holding voting files was not mounted at some point.")

            m_cols = st.columns(3) if mobile_view else st.columns(4)

            def _m(idx, label, val):
                with m_cols[idx % len(m_cols)]:
                    st.metric(label, int(val))

            _m(0, "🚨 Instance Terminations", term_count)
            _m(1, "🟢 Mounts", type_counts.get("Diskgroup Mounted", 0))
            _m(2, "🔴 Dismounts", type_counts.get("Diskgroup Dismounted", 0))
            _m(3, "⚠️ Mount Failures", type_counts.get("Diskgroup Mount Failed", 0))
            m_cols2 = st.columns(3) if mobile_view else st.columns(4)

            def _m2(idx, label, val):
                with m_cols2[idx % len(m_cols2)]:
                    st.metric(label, int(val))

            _m2(0, "⚖️ Rebalances", type_counts.get("Rebalance Started", 0))
            _m2(1, "💾 Disk Add/Drop/Offline/De-assign",
                type_counts.get("Disk Added", 0) + type_counts.get("Disk Dropped", 0)
                + type_counts.get("Disk Offline Initiated", 0) + type_counts.get("Disk De-assignment", 0))
            _m2(2, "🗳️ Voting Risks", voting_risk_count)
            _m2(3, "🔴 ORA / ASM Errors", type_counts.get("ASM Error", 0) + type_counts.get("ORA Error", 0))

            recfg_count = type_counts.get("Cluster Reconfiguration", 0)
            procterm_count = type_counts.get("Process Termination Requested", 0)
            if recfg_count > 0 or procterm_count > 0:
                m_cols3 = st.columns(2)
                with m_cols3[0]:
                    st.metric("🔄 Cluster Reconfigurations", int(recfg_count))
                with m_cols3[1]:
                    st.metric("⚡ Process Terminations Requested", int(procterm_count))

            asm_tab_labels = [
                "🚨 Instance Health", "🔄 Mount / Dismount", "⚖️ Rebalance Ops",
                "💾 Disk Add / Drop / Offline / De-assign", "🔌 Client & Voting",
                "🧨 ASM / ORA Errors", "🔄 Reconfig & Proc Term", "📋 All ASM Events"
            ]
            asm_tabs = st.tabs(asm_tab_labels)

            def _show_asm_subset(event_types, empty_msg):
                sub = df_asm_display[df_asm_display["Event Type"].isin(event_types)]
                if sub.empty:
                    st.info(empty_msg)
                else:
                    st.dataframe(
                        sub.drop(columns=["ParsedTimestamp"], errors="ignore"),
                        use_container_width=True
                    )

            with asm_tabs[0]:
                _show_asm_subset(
                    ["Instance Termination Initiated", "Instance Terminated"],
                    "✅ No instance crash/termination events found"
                )
            with asm_tabs[1]:
                _show_asm_subset(
                    ["Diskgroup Mounted", "Diskgroup Dismounted", "Diskgroup Mount Failed"],
                    "✅ No mount/dismount events found"
                )
            with asm_tabs[2]:
                _show_asm_subset(
                    ["Rebalance Started", "Rebalance Completed", "Rebalance Interrupted"],
                    "✅ No rebalance operations found"
                )
            with asm_tabs[3]:
                _show_asm_subset(
                    ["Disk Added", "Disk Dropped", "Disk Offline Initiated", "Disk De-assignment"],
                    "✅ No disk add/drop/offline/de-assignment events found"
                )
            with asm_tabs[4]:
                _show_asm_subset(
                    ["Client Disconnected", "Client Reconnected", "Voting File Activity", "Voting File At Risk"],
                    "✅ No client connection/voting events found"
                )
            with asm_tabs[5]:
                _show_asm_subset(["ASM Error", "ORA Error"], "✅ No ASM/ORA error lines found")
            with asm_tabs[6]:
                st.caption(
                    "Cluster reconfiguration events (Grid Infrastructure/ASM instance membership changes) and "
                    "OS-level process termination requests — both are useful correlation signals around "
                    "instance instability even when they aren't errors by themselves."
                )
                _show_asm_subset(
                    ["Cluster Reconfiguration", "Process Termination Requested"],
                    "✅ No reconfiguration or process termination events found"
                )
            with asm_tabs[7]:
                st.dataframe(
                    df_asm_display.drop(columns=["ParsedTimestamp"], errors="ignore"),
                    use_container_width=True
                )

                st.markdown("#### 📊 ASM Event Distribution")
                dist = df_asm_display["Event Type"].value_counts().reset_index()
                dist.columns = ["Event Type", "Count"]
                st.dataframe(dist, use_container_width=True)

                if not df_asm_display.empty:
                    dg_dist = df_asm_display[df_asm_display["Diskgroup"] != "-"]["Diskgroup"].value_counts().reset_index()
                    if not dg_dist.empty:
                        dg_dist.columns = ["Diskgroup", "Event Count"]
                        st.markdown("#### 💽 Events by Diskgroup")
                        st.dataframe(dg_dist, use_container_width=True)

# ---------------- ORA Errors & Warnings Tabs ----------------
expand_errors_tab = st.session_state.get("voice_action") == "show_errors"
expand_warnings_tab = st.session_state.get("voice_action") == "show_warnings"

# If either tab should be expanded, show that one
if expand_errors_tab or expand_warnings_tab:
    tab_ora, tab_warn, tab_new = st.tabs(["🔴 ORA Errors", "🟡 Warnings", "🆕 New/Unclassified"])
    
    with tab_ora:
        with st.expander("📋 ORA Error Details", expanded=expand_errors_tab):
            if not df_ora_display.empty:
                st.dataframe(df_ora_display.drop(columns=["ParsedTimestamp"], errors="ignore"), use_container_width=True)
                
                st.markdown("#### 📊 Error Distribution")
                counts = df_ora_display["ORA Error"].value_counts().reset_index()
                counts.columns = ["ORA Error", "Count"]
                st.dataframe(counts, use_container_width=True)
            else:
                st.info("✅ No ORA errors found in selected range/search")
    
    with tab_warn:
        with st.expander("📋 Warning Details", expanded=expand_warnings_tab):
            if not df_warn_display.empty:
                st.dataframe(df_warn_display.drop(columns=["ParsedTimestamp"], errors="ignore"), use_container_width=True)

                if "Category" in df_warn_display.columns and df_warn_display["Category"].nunique() > 1:
                    st.markdown("#### 🗂️ Warnings by Category")
                    cat_counts = df_warn_display["Category"].value_counts().reset_index()
                    cat_counts.columns = ["Category", "Count"]
                    st.dataframe(cat_counts, use_container_width=True)

                st.markdown("#### 📊 Top Warnings")
                top_w = df_warn_display["Warning Message"].value_counts().head(20).reset_index()
                top_w.columns = ["Warning Message", "Count"]
                st.dataframe(top_w, use_container_width=True)
            else:
                st.info("✅ No warnings found in selected range/search")

    with tab_new:
        with st.expander("🆕 Unclassified / Possible New Patterns", expanded=False):
            st.caption(
                "Lines that don't match any known ORA/Warning/RAC/DG/RMAN/Data Pump pattern, but either "
                "look like an Oracle-style error code (e.g. a future/unfamiliar PREFIX-NNNNN) or contain "
                "a high-signal severity word. This is a safety net for message types this tool doesn't "
                "have a dedicated rule for yet — review it periodically so nothing new goes unnoticed."
            )
            if not df_unclassified_display.empty:
                st.dataframe(df_unclassified_display.drop(columns=["ParsedTimestamp"], errors="ignore"), use_container_width=True)

                st.markdown("#### 🗂️ By Match Type")
                mt_counts = df_unclassified_display["Match Type"].value_counts().reset_index()
                mt_counts.columns = ["Match Type", "Count"]
                st.dataframe(mt_counts, use_container_width=True)

                st.markdown("#### 📊 Most Frequent Unmapped Codes/Keywords")
                matched_counts = df_unclassified_display["Matched"].value_counts().head(20).reset_index()
                matched_counts.columns = ["Matched", "Count"]
                st.dataframe(matched_counts, use_container_width=True)
            else:
                st.success("✅ Nothing unclassified in the selected range/search — everything matched a known pattern.")
else:
    # Normal tabs without forced expansion
    tab_ora, tab_warn, tab_new = st.tabs(["🔴 ORA Errors", "🟡 Warnings", "🆕 New/Unclassified"])
    
    with tab_ora:
        with st.expander("📋 ORA Error Details", expanded=True):
            if not df_ora_display.empty:
                st.dataframe(df_ora_display.drop(columns=["ParsedTimestamp"], errors="ignore"), use_container_width=True)
                
                st.markdown("#### 📊 Error Distribution")
                counts = df_ora_display["ORA Error"].value_counts().reset_index()
                counts.columns = ["ORA Error", "Count"]
                st.dataframe(counts, use_container_width=True)
            else:
                st.info("✅ No ORA errors found in selected range/search")
    
    with tab_warn:
        with st.expander("📋 Warning Details", expanded=True):
            if not df_warn_display.empty:
                st.dataframe(df_warn_display.drop(columns=["ParsedTimestamp"], errors="ignore"), use_container_width=True)

                if "Category" in df_warn_display.columns and df_warn_display["Category"].nunique() > 1:
                    st.markdown("#### 🗂️ Warnings by Category")
                    cat_counts = df_warn_display["Category"].value_counts().reset_index()
                    cat_counts.columns = ["Category", "Count"]
                    st.dataframe(cat_counts, use_container_width=True)

                st.markdown("#### 📊 Top Warnings")
                top_w = df_warn_display["Warning Message"].value_counts().head(20).reset_index()
                top_w.columns = ["Warning Message", "Count"]
                st.dataframe(top_w, use_container_width=True)
            else:
                st.info("✅ No warnings found in selected range/search")

    with tab_new:
        with st.expander("🆕 Unclassified / Possible New Patterns", expanded=False):
            st.caption(
                "Lines that don't match any known ORA/Warning/RAC/DG/RMAN/Data Pump pattern, but either "
                "look like an Oracle-style error code (e.g. a future/unfamiliar PREFIX-NNNNN) or contain "
                "a high-signal severity word. This is a safety net for message types this tool doesn't "
                "have a dedicated rule for yet — review it periodically so nothing new goes unnoticed."
            )
            if not df_unclassified_display.empty:
                st.dataframe(df_unclassified_display.drop(columns=["ParsedTimestamp"], errors="ignore"), use_container_width=True)

                st.markdown("#### 🗂️ By Match Type")
                mt_counts = df_unclassified_display["Match Type"].value_counts().reset_index()
                mt_counts.columns = ["Match Type", "Count"]
                st.dataframe(mt_counts, use_container_width=True)

                st.markdown("#### 📊 Most Frequent Unmapped Codes/Keywords")
                matched_counts = df_unclassified_display["Matched"].value_counts().head(20).reset_index()
                matched_counts.columns = ["Matched", "Count"]
                st.dataframe(matched_counts, use_container_width=True)
            else:
                st.success("✅ Nothing unclassified in the selected range/search — everything matched a known pattern.")

# ---------------- Error Frequency Chart ----------------
with st.expander("📈 ORA Error Frequency Chart", expanded=False):
    if df_ora_all.empty or df_ora_all["ParsedTimestamp"].isna().all():
        st.info("No timestamped ORA data available to plot")
    else:
        log_col = None
        if "AlertLogName" in df_ora_all.columns:
            log_col = "AlertLogName"
        elif "Filename" in df_ora_all.columns:
            log_col = "Filename"
        elif "Source" in df_ora_all.columns:
            log_col = "Source"

        if log_col is None:
            df_ora_all["__AlertLogGroup__"] = "All Logs Combined"
            log_col = "__AlertLogGroup__"

        log_list = sorted(df_ora_all[log_col].dropna().unique())

        if len(log_list) > 1:
            selected_log = st.selectbox("📂 Select Alert Log", log_list, key="selected_alert_log")
            df_selected = df_ora_all[df_ora_all[log_col] == selected_log].copy()
        else:
            selected_log = log_list[0]
            st.info(f"📂 Showing: **{selected_log}**")
            df_selected = df_ora_all.copy()

        if df_selected.empty:
            st.warning("No ORA errors found in the selected alert log")
        else:
            overall_min = df_selected["ParsedTimestamp"].min()
            overall_max = df_selected["ParsedTimestamp"].max()

            # Default to Daily granularity for wide date ranges. Hourly
            # buckets across 1-2+ weeks produce hundreds of bars, which is
            # what made the chart unreadable — Daily keeps it clean, and the
            # user can still switch to Hourly for a narrower window.
            _span_days = (overall_max - overall_min).days if pd.notna(overall_max) and pd.notna(overall_min) else 0
            _default_granularity_idx = 1 if _span_days > 3 else 0

            col1, col2, col3 = st.columns([2, 2, 1])
            with col1:
                chart_start_date = st.date_input("Chart start date",
                                                 overall_min.astimezone(LOCAL_TZ).date(),
                                                 key="chart_start_date")
                chart_start_time = st.time_input("Chart start time",
                                                 overall_min.astimezone(LOCAL_TZ).time(),
                                                 key="chart_start_time")
            with col2:
                chart_end_date = st.date_input("Chart end date",
                                               overall_max.astimezone(LOCAL_TZ).date(),
                                               key="chart_end_date")
                chart_end_time = st.time_input("Chart end time",
                                               overall_max.astimezone(LOCAL_TZ).time(),
                                               key="chart_end_time")
            with col3:
                view_mode = st.radio("Granularity", ["Hourly", "Daily"], index=_default_granularity_idx, key="chart_view")

            chart_start_dt = datetime.combine(chart_start_date, chart_start_time).replace(tzinfo=LOCAL_TZ)
            chart_end_dt = datetime.combine(chart_end_date, chart_end_time).replace(tzinfo=LOCAL_TZ)

            df_chart_base = df_selected[df_selected["ParsedTimestamp"].notna()].copy()
            df_chart_base = df_chart_base[
                (df_chart_base["ParsedTimestamp"] >= chart_start_dt)
                & (df_chart_base["ParsedTimestamp"] <= chart_end_dt)
            ]

            if df_chart_base.empty:
                st.warning("No ORA errors in the selected chart time window")
            else:
                if view_mode == "Hourly":
                    df_chart_base["TimeBucket"] = df_chart_base["ParsedTimestamp"].dt.floor("h")
                    df_chart_base["MinuteStr"] = df_chart_base["ParsedTimestamp"].dt.strftime("%Y-%m-%d %H:%M")
                else:
                    df_chart_base["TimeBucket"] = df_chart_base["ParsedTimestamp"].dt.floor("d")
                    df_chart_base["MinuteStr"] = df_chart_base["ParsedTimestamp"].dt.strftime("%Y-%m-%d")

                freq = df_chart_base.groupby(["TimeBucket", "ORA Error"]).size().reset_index(name="Count")

                if view_mode == "Hourly":
                    sample_minutes = df_chart_base.groupby(["TimeBucket", "ORA Error"])["MinuteStr"].agg(
                        lambda s: ", ".join(sorted(set(s))[:6])
                    ).reset_index(name="SampleMinutes")
                    freq = freq.merge(sample_minutes, on=["TimeBucket", "ORA Error"], how="left")
                else:
                    freq["SampleMinutes"] = freq["TimeBucket"].dt.strftime("%Y-%m-%d")

                import plotly.graph_objects as go

                total_by_code = freq.groupby("ORA Error")["Count"].sum().sort_values(ascending=False)
                all_codes_sorted = list(total_by_code.index)
                n_codes = len(all_codes_sorted)
                n_buckets = freq["TimeBucket"].nunique()
                label_fmt = "%d-%b %H:%M" if view_mode == "Hourly" else "%d-%b-%Y"
                x_label = "Hour" if view_mode == "Hourly" else "Date"
                tickformat = "%d-%b\n%H:%M" if view_mode == "Hourly" else "%d-%b-%Y"

                # Heatmap is the only chart type now (Bar/Line removed).
                pivot = freq.pivot_table(index="ORA Error", columns="TimeBucket", values="Count", fill_value=0)
                pivot = pivot.reindex(all_codes_sorted)  # busiest code on top
                z_raw = pivot.values
                max_count = int(z_raw.max()) if z_raw.size else 0

                # A linear color scale gets crushed whenever one code (like
                # ORA-00132 above, in the thousands) massively outnumbers
                # everything else — every other cell maps to ~0% of the
                # scale and renders as near-invisible white-on-white.
                # Coloring by log(1+count) instead spreads the scale out so
                # low counts still get real, visible color, while the
                # colorbar and hover still show true counts.
                z_color = np.log1p(z_raw)

                if max_count > 0:
                    candidate_ticks = [0, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
                    tick_actual = sorted(set([t for t in candidate_ticks if t <= max_count] + [max_count]))
                    colorbar_kwargs = dict(
                        title="Count",
                        tickvals=np.log1p(tick_actual),
                        ticktext=[str(t) for t in tick_actual],
                    )
                else:
                    colorbar_kwargs = dict(title="Count")

                # Build hover text in Python rather than relying on Plotly's
                # %{customdata} template substitution, which was showing up
                # as the literal, unresolved token "Count: %{customdata}"
                # in the tooltip instead of the actual count.
                row_labels = list(pivot.index)
                col_labels = list(pivot.columns)
                hover_text = [
                    [
                        f"<b>{row_labels[i]}</b><br>{pd.Timestamp(col_labels[j]).strftime(label_fmt)}<br>Count: {int(z_raw[i][j])}"
                        for j in range(len(col_labels))
                    ]
                    for i in range(len(row_labels))
                ]

                fig = go.Figure(data=go.Heatmap(
                    z=z_color,
                    x=col_labels,
                    y=row_labels,
                    zmin=0,
                    colorscale=[
                        [0.0, '#ffffff'], [0.06, '#e6ebfb'], [0.18, '#c2cffb'],
                        [0.38, '#8ea6f5'], [0.58, '#667eea'], [0.78, '#c2185b'],
                        [1.0, '#7a0930'],
                    ],
                    colorbar=colorbar_kwargs,
                    text=hover_text,
                    hoverinfo="text",
                    xgap=1, ygap=2,
                ))
                fig.update_layout(
                    title=f"ORA Error Frequency Heatmap ({view_mode}) – {selected_log}",
                    xaxis=dict(
                        title=x_label, type="date", tickformat=tickformat,
                        tickangle=-45 if view_mode == "Hourly" else 0,
                        tickfont=dict(size=10), nticks=min(30, max(6, n_buckets)),
                        automargin=True, showgrid=False,
                    ),
                    yaxis=dict(title="ORA Error", automargin=True, tickfont=dict(size=11), showgrid=False),
                    height=max(420, 26 * n_codes + 160),
                    margin=dict(l=110, r=30, t=70, b=80),
                    plot_bgcolor="#fafbfd",
                    paper_bgcolor="white",
                    font=dict(family="Arial, sans-serif", size=12, color="#333"),
                )
                st.plotly_chart(fig, use_container_width=True)

# ---------------- Kill Session Events ----------------
expand_kills = st.session_state.get("voice_action") == "show_kills"
with st.expander("⚡ Kill Session Events", expanded=expand_kills):
    if df_kill_all.empty:
        st.success("✅ No kill session events detected")
    else:
        st.markdown(f"""
        <div style='background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); 
                    padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
            <h4 style='margin: 0 0 0.5rem 0;'>⚡ Session Termination Analysis</h4>
            <p style='margin: 0; opacity: 0.9;'>Total Kill Session Events: <strong>{len(df_kill_display)}</strong></p>
        </div>
        """, unsafe_allow_html=True)
        
        if not df_kill_display.empty:
            col1, col2, col3 = st.columns(3)
            with col1:
                unique_sids = df_kill_display["SID"].nunique()
                st.metric("🎯 Unique SIDs Killed", unique_sids)
            with col2:
                kill_modes = df_kill_display["Mode"].value_counts()
                most_common_mode = kill_modes.index[0] if not kill_modes.empty else "N/A"
                st.metric("🔧 Most Common Mode", most_common_mode)
            with col3:
                kill_reasons = df_kill_display["Reason"].value_counts()
                most_common_reason = kill_reasons.index[0] if not kill_reasons.empty else "N/A"
                display_reason = str(most_common_reason)[:30] + "..." if len(str(most_common_reason)) > 30 else str(most_common_reason)
                st.metric("📋 Most Common Reason", display_reason)
            
            st.markdown("---")
            st.markdown("#### 📋 Kill Session Details")
            display_cols = ["Timestamp", "SID", "Serial#", "Reason", "Mode", "Requestor", "Owner", "Source"]
            st.dataframe(df_kill_display[display_cols], use_container_width=True, height=400)
        else:
            st.info("🔍 No kill session events found in the selected time range/search criteria")

# ---------------- Trace Files Found ----------------
expand_trace = st.session_state.get("voice_action") == "show_trace"
with st.expander("🗂️ Trace Files Found", expanded=expand_trace):
    if df_trace_all.empty:
        st.info("🔭 No .trc trace file references found in the uploaded logs")
    else:
        st.markdown(f"""
        <div style='background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); 
                    padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
            <h4 style='margin: 0 0 0.5rem 0;'>🗂️ Trace File References</h4>
            <p style='margin: 0; opacity: 0.9;'>Every .trc file mentioned in the logs, with its timestamp</p>
        </div>
        """, unsafe_allow_html=True)

        if not df_trace_display.empty:
            col1, col2, col3 = st.columns(3)
            with col1:
                st.metric("📄 Total References", len(df_trace_display))
            with col2:
                st.metric("🗂️ Unique Trace Files", df_trace_display["Trace File"].nunique())
            with col3:
                st.metric("📦 Source Logs", df_trace_display["Source"].nunique())

            st.markdown("---")
            st.markdown("#### 📋 Trace File Details")
            display_cols = ["Timestamp", "Trace File", "Source", "Raw Line"]
            st.dataframe(
                df_trace_display[display_cols].sort_values("Timestamp"),
                use_container_width=True,
                height=400
            )

            csv_data = df_trace_display[display_cols].to_csv(index=False).encode("utf-8")
            st.download_button(
                "📥 Download Trace File List (CSV)",
                data=csv_data,
                file_name=f"trace_files_{datetime.now().strftime('%Y%m%d_%H%M')}.csv",
                mime="text/csv",
                use_container_width=True
            )
        else:
            st.info("🔍 No trace file references found in the selected time range/search criteria")

# ---------------- Compare Two Logs ----------------
with st.expander("🔄 Compare Two Uploaded Logs", expanded=False):
    file_names = list(per_file_lines.keys())
    if len(file_names) < 2:
        st.info("📤 Upload at least two files to compare")
    else:
        col1, col2 = st.columns(2)
        with col1:
            file_a = st.selectbox("📄 File A (baseline)", file_names, index=0)
        with col2:
            file_b = st.selectbox("📄 File B (compare)", file_names, index=1 if len(file_names) > 1 else 0)

        if st.button("🔍 Run Compare", use_container_width=True):
            with st.spinner("Comparing logs..."):
                ora_a, warn_a, kill_a, trace_a, _u_a = analyze_alert_log_lines(per_file_lines[file_a], source_name=file_a)
                ora_b, warn_b, kill_b, trace_b, _u_b = analyze_alert_log_lines(per_file_lines[file_b], source_name=file_b)
                comp = compare_two_parsed_lists(ora_a, ora_b)
            
            st.markdown("#### 📊 Counts by ORA Error (A vs B)")
            st.dataframe(comp["counts"], use_container_width=True)
            
            col1, col2 = st.columns(2)
            with col1:
                st.markdown("#### ➕ New in B (not in A)")
                if comp["new_in_b"]:
                    st.dataframe(pd.DataFrame(comp["new_in_b"]), use_container_width=True)
                else:
                    st.success("✅ No new ORA entries in B")
            
            with col2:
                st.markdown("#### ➖ Only in A (missing in B)")
                if comp["new_in_a"]:
                    st.dataframe(pd.DataFrame(comp["new_in_a"]), use_container_width=True)
                else:
                    st.success("✅ No unique entries in A")

# ---------------- Mistral AI Analysis ----------------
expand_ai = st.session_state.get("voice_action") == "show_ai"
with st.expander("🤖 Mistral AI Analysis (Oracle Performance Expert)", expanded=expand_ai):
    st.markdown("""
    <div style='background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
        <h4 style='margin: 0 0 0.5rem 0;'>🧠 AI-Powered Analysis</h4>
        <p style='margin: 0; opacity: 0.9;'>Get expert insights from Mistral AI about your Oracle alert logs</p>
    </div>
    """, unsafe_allow_html=True)
    
    user_prompt = st.text_area("💬 Your instruction:", 
                               "Analyze logs between 18:00 and 19:00 on 2025-10-14 for performance issues",
                               height=120)
    use_filtered_segment = st.checkbox("🎯 Use currently filtered segment for AI analysis", value=True)

    logs = {name: "\n".join(lines) for name, lines in per_file_lines.items()} if per_file_lines else {}

    if not logs:
        st.warning("⚠️ Please upload at least one alert log to use Mistral AI analysis")
    else:
        if len(logs) > 1:
            selected_log = st.selectbox("📂 Select Alert Log to Analyze:", list(logs.keys()))
        else:
            selected_log = list(logs.keys())[0]
            st.info(f"📂 Selected: **{selected_log}**")

        if "mistral_cache" not in st.session_state:
            st.session_state.mistral_cache = {}

        if st.button("🚀 Run Mistral AI Analysis", use_container_width=True):
            if not user_prompt.strip():
                st.warning("⚠️ Please enter your instruction before running analysis")
            else:
                snippet_lines = []
                if use_filtered_segment and (not df_ora_display.empty or not df_warn_display.empty):
                    file_lines = per_file_lines.get(selected_log, [])
                    def add_context_from_df(df):
                        for _, row in df[df["Source"] == selected_log].iterrows():
                            raw_line = row.get("Raw Line", "")
                            if not raw_line:
                                continue
                            try:
                                idx = next((i for i, l in enumerate(file_lines) if raw_line in l), None)
                            except Exception:
                                idx = None
                            if isinstance(idx, int):
                                start_i = max(0, idx - 3)
                                end_i = min(len(file_lines), idx + 4)
                                snippet_lines.extend(file_lines[start_i:end_i])
                            else:
                                snippet_lines.append(raw_line)

                    add_context_from_df(df_ora_display if not df_ora_display.empty else pd.DataFrame())
                    add_context_from_df(df_warn_display if not df_warn_display.empty else pd.DataFrame())

                    if not snippet_lines:
                        snippet_lines = file_lines
                else:
                    snippet_lines = per_file_lines.get(selected_log, [])

                snippet = "\n".join(snippet_lines)[:MAX_PROMPT_CHARS]
                if not snippet.strip():
                    st.warning("⚠️ No log content available to send to AI")
                else:
                    error_summary = "\n".join([f"{r['Timestamp']} - {r['ORA Error']}" 
                                               for _, r in df_ora_display[df_ora_display["Source"] == selected_log].iterrows()]) \
                                    if not df_ora_display.empty else "No ORA errors in selected segment"
                    full_prompt = f"""
You are an Oracle Performance Expert analyzing the following alert log segment.
User instruction:
{user_prompt}

Detected ORA Errors:
{error_summary}

Alert Log Extract:
{snippet}
"""

                    cache_key = f"{selected_log}||{user_prompt.strip()}||{use_filtered_segment}||{global_start_dt.isoformat()}||{global_end_dt.isoformat()}"
                    if cache_key in st.session_state.mistral_cache:
                        ai_result = st.session_state.mistral_cache[cache_key]
                    else:
                        with st.spinner("🤖 Analyzing with Mistral AI..."):
                            ai_result = ai_generate(full_prompt)
                        st.session_state.mistral_cache[cache_key] = ai_result

                    st.markdown("""
                    <div style='background: white; padding: 2rem; border-radius: 8px; 
                                border-left: 4px solid #667eea; margin-top: 1rem;'>
                    """, unsafe_allow_html=True)
                    st.markdown(ai_result)
                    st.markdown("</div>", unsafe_allow_html=True)

# ---------------- Download Section ----------------
expand_download = st.session_state.get("voice_action") == "export"
with st.expander("💾 Download Parsed Results", expanded=expand_download):
    if (not combined_ora) and (not combined_warnings) and (not combined_kill_sessions) and (not combined_asm_events) and (not combined_trace_files):
        st.info("🔭 No parsed data to download")
    else:
        st.markdown("""
        <div style='background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); 
                    padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
            <h4 style='margin: 0 0 0.5rem 0;'>📥 Export Your Analysis</h4>
            <p style='margin: 0; opacity: 0.9;'>Download complete parsed results in Excel format</p>
        </div>
        """, unsafe_allow_html=True)
        
        # Create separate sheets for better organization
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="xlsxwriter") as writer:
            if not df_ora_all.empty:
                df_ora_export = df_ora_all.copy()
                # Convert timestamps for Excel compatibility
                for col in df_ora_export.columns:
                    if ptypes.is_datetime64_any_dtype(df_ora_export[col]):
                        try:
                            df_ora_export[col] = df_ora_export[col].dt.tz_localize(None)
                        except:
                            pass
                df_ora_export.to_excel(writer, index=False, sheet_name="ORA_Errors")
            
            if not df_warn_all.empty:
                df_warn_export = df_warn_all.copy()
                for col in df_warn_export.columns:
                    if ptypes.is_datetime64_any_dtype(df_warn_export[col]):
                        try:
                            df_warn_export[col] = df_warn_export[col].dt.tz_localize(None)
                        except:
                            pass
                df_warn_export.to_excel(writer, index=False, sheet_name="Warnings")
            
            if not df_kill_all.empty:
                df_kill_export = df_kill_all.copy()
                for col in df_kill_export.columns:
                    if ptypes.is_datetime64_any_dtype(df_kill_export[col]):
                        try:
                            df_kill_export[col] = df_kill_export[col].dt.tz_localize(None)
                        except:
                            pass
                df_kill_export.to_excel(writer, index=False, sheet_name="Kill_Sessions")

            if not df_asm_all.empty:
                df_asm_export = df_asm_all.copy()
                for col in df_asm_export.columns:
                    if ptypes.is_datetime64_any_dtype(df_asm_export[col]):
                        try:
                            df_asm_export[col] = df_asm_export[col].dt.tz_localize(None)
                        except:
                            pass
                df_asm_export.to_excel(writer, index=False, sheet_name="ASM_Events")

            if not df_unclassified_all.empty:
                df_unclassified_export = df_unclassified_all.copy()
                for col in df_unclassified_export.columns:
                    if ptypes.is_datetime64_any_dtype(df_unclassified_export[col]):
                        try:
                            df_unclassified_export[col] = df_unclassified_export[col].dt.tz_localize(None)
                        except:
                            pass
                df_unclassified_export.to_excel(writer, index=False, sheet_name="Unclassified_New")

            if not df_trace_all.empty:
                df_trace_export = df_trace_all.copy()
                for col in df_trace_export.columns:
                    if ptypes.is_datetime64_any_dtype(df_trace_export[col]):
                        try:
                            df_trace_export[col] = df_trace_export[col].dt.tz_localize(None)
                        except:
                            pass
                df_trace_export.to_excel(writer, index=False, sheet_name="Trace_Files")

        filename = f"parsed_alert_log_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
        st.download_button(
            "📥 Download Excel Report", 
            data=buf.getvalue(), 
            file_name=filename, 
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            use_container_width=True
        )

# ---------------- Footer ----------------
st.markdown("---")

footer_color = "#000000" if theme_choice == "Light Mode" else "#f0f0f0"
footer_bg = "#f9f9f9" if theme_choice == "Light Mode" else "#1e1e1e"

# Mobile-friendly footer
if mobile_view:
    st.markdown(f"""
    <div style='text-align: center; padding: 1rem; color: {footer_color}; 
                background: {footer_bg}; border-radius: 8px; opacity: 0.9;'>
        <p style='margin: 0; font-size: 0.85rem;'>🧠 Oracle Alert Log Analyzer Pro</p>
        <p style='margin: 0.3rem 0 0 0; font-size: 0.75rem;'>Built for DBAs | © 2025</p>
    </div>
    """, unsafe_allow_html=True)
else:
    st.markdown(f"""
    <div style='text-align: center; padding: 2rem; color: {footer_color}; 
                background: {footer_bg}; border-radius: 8px; opacity: 0.9;'>
        <p style='margin: 0;'>🧠 Oracle Alert Log Analyzer Pro | Built for DBAs | Powered by Streamlit & Mistral AI</p>
        <p style='margin: 0.5rem 0 0 0; font-size: 0.9rem;'>© 2025 | Advanced Diagnostic Tool</p>
    </div>
    """, unsafe_allow_html=True)

# Clear voice action after processing (but keep it for one cycle to allow expander to open)
if st.session_state.get("voice_action") and st.session_state.get("voice_action_processed"):
    st.session_state.voice_action = None
    st.session_state.voice_action_processed = False
elif st.session_state.get("voice_action"):
    st.session_state.voice_action_processed = True
