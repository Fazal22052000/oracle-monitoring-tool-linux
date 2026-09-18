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
    r"Data Pump job|KUPC\$[CS]_)"
    # Instance crash / abnormal termination — confirmed against real matches
    # in this environment's own alert logs ("Instance terminated by USER,
    # pid = ...", "USER (ospid: NNNNN): terminating the instance"). This is
    # the single highest-severity event an alert log can contain and was
    # previously invisible in the main RDBMS parser (it has no ORA- code and
    # never contains the word "WARNING").
    r"|(?P<instcrash>Instance terminated by\s+\S+|terminating the instance\b|"
    r"System state dump requested.*abnormal instance termination)"
    # OS-level process kill — "Killed process oracle@host (Q003) with pid is
    # NNNN, OS pid NNNNNNNN" — an external/OS-initiated kill of an Oracle
    # background/shadow process, distinct from a SQL "KILL SESSION".
    r"|(?P<oskill>Killed process\s+\S+.*\bwith pid\b)"
    # Archiver / redo log stuck — "Cannot allocate log, archival required"
    # means redo generation is about to stall the whole instance because the
    # archiver can't keep up; extremely high signal for a DBA.
    r"|(?P<archiver>Cannot allocate log,\s*archival required|"
    r"Archival required, cannot allocate log)"
    # Latch contention severe enough that a process gives up entirely
    # ("CL00 failed to acquire latch") rather than just waiting/spinning.
    r"|(?P<latch>failed to acquire latch)"
    # Process spawn / startup failures — job queue slaves, parallel query
    # (PX) servers, or a generic background process failing to start.
    r"|(?P<spawnfail>unable to spawn\s+\S*\s*process|Process startup failed|"
    r"Error occured? while spawning process|PX server failed to join)"
    # SQL parse failures reported directly in the alert log (as opposed to
    # ORA- errors returned to a client) — "PARSE ERROR: ospid=..." and
    # "Parse failure in sqlid=...".
    r"|(?P<parsefail>Parse failure in sqlid=|PARSE ERROR:\s*ospid=)"
    # Distributed transaction (two-phase commit) errors — "Error NNNN
    # trapped in 2PC on transaction ...".
    r"|(?P<twopc>trapped in 2PC)"
    # OS-level error lines that immediately follow an NI/IPC failure and
    # name the underlying OS error (e.g. "IBM AIX RISC System/6000 Error:
    # 2: No such file or directory") — platform-agnostic so it still fires
    # on Linux/Solaris/HP-UX/Windows environments.
    r"|(?P<oserr>\b(?:IBM AIX RISC System/6000|Linux(?:-x86_64)?|Solaris|"
    r"HP-?UX|Windows(?:\sNT)?)\s+Error:\s*\d+)"
    # Multitenant (CDB/PDB) lifecycle — confirmed exact wording from Oracle
    # docs/support examples: "Pluggable database ORCLPDB1 opened read
    # write", "Pluggable Database closed", "Opening pdb <name> (<con_id>)
    # with Resource Manager plan: ...", and the "PDB altered with errors"
    # warning when a PDB opens in restricted mode due to a plug-in
    # violation. Near-universal in 12c+/19c+ production, previously not
    # tracked at all despite having no ORA- code of its own.
    r"|(?P<pdb>Pluggable [Dd]atabase\s+\S+\s+(?:opened|closed)|"
    r"PDB altered with errors|Opening pdb\s)"
    # Hang Manager (DIA0) — ORA-32701 itself is already caught generically
    # via ORA_RE, but the surrounding narrative lines that explain WHAT is
    # about to happen (a session or the whole instance being killed to
    # resolve a detected hang) carry no ORA- code of their own and were
    # previously invisible.
    r"|(?P<hang>DIA0 (?:requesting termination|Instance \d+ requires instance termination)|"
    r"Hang Resolution Reason|GLOBAL,\s*HIGH confidence hang|Possible hangs up to hang ID)"
    # Instance lifecycle — startup/shutdown milestones a DBA needs to know
    # happened even though they're purely informational (no ORA- code, no
    # "WARNING"): was the instance bounced, and when.
    r"|(?P<instlife>Starting ORACLE instance|ORACLE instance started|"
    r"Instance shutdown complete|Shutting down instance|"
    r"\bDatabase mounted\b|\bDatabase opened\b)"
    # Resumable space allocation — a session was SUSPENDED (not failed) due
    # to a space/quota condition (e.g. tablespace full) and is waiting for
    # someone to fix it; genuinely different from a hard ORA- failure and
    # easy to miss since the client-side error is delayed/never seen.
    r"|(?P<resumable>statement in resumable session '[^']*' was suspended)",
    re.I
)
NOTABLE_EVENT_LABELS = {
    "tns": "TNS/Listener", "ckpt": "Checkpoint Stall", "logsw": "Log Switch Stall",
    "rac": "RAC/Cluster", "dg": "Data Guard/Redo Transport", "flashback": "Flashback",
    "rman": "RMAN", "datapump": "Data Pump",
    "instcrash": "Instance Crash/Termination", "oskill": "OS Process Kill",
    "archiver": "Archiver/Redo Stuck", "latch": "Latch Contention/Failure",
    "spawnfail": "Process Spawn Failure", "parsefail": "SQL Parse Failure",
    "twopc": "Distributed Transaction (2PC) Error", "oserr": "OS-Level Error",
    "pdb": "Pluggable Database (PDB) Lifecycle", "hang": "Hang Manager (DIA0)",
    "instlife": "Instance Startup/Shutdown", "resumable": "Resumable Session Suspended",
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
    r"PERMISSION DENIED|CORRUPT(?:ED|ION)?|UNRECOVERABLE|FATAL ERROR|"
    r"CRASH(?:ED)?|DEADLOCK|HUNG|UNAVAILABLE|EMERGENCY|SEVERE|"
    r"DATA LOSS|SECURITY VIOLATION|SEGMENTATION FAULT|CORE DUMP|"
    r"STACK TRACE|ASSERTION (?:FAILED|VIOLATION)|INTERNAL ERROR)\b", re.I
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

# Quorum loss ("no read quorum in group: required N, found M disks") means
# the disk group cannot reliably read its own metadata and is at imminent
# risk of forced dismount / data unavailability — confirmed real-world
# wording (Oracle Support/community incident reports). Technically this
# already starts with "ERROR:" and would be caught by the generic
# ASM_ERROR_RE below, but it's severe enough to deserve its own distinct,
# higher-visibility category rather than being buried in generic "ASM
# Error" rows.
ASM_QUORUM_LOSS_RE = re.compile(r"no read quorum in group", re.I)

# "WARNING: Waited N secs for write IO to PST disk M in group G" — the PST
# (Partnership and Status Table) heartbeat write is stalling, which is the
# direct precursor to ASM force-offlining that disk (and, if it repeats
# across enough disks, dismounting the whole disk group). Same reasoning
# as the quorum-loss pattern above: already covered by generic WARN_RE,
# but distinct/severe enough to name explicitly.
ASM_PST_IO_WAIT_RE = re.compile(r"Waited\s+\d+\s+secs?\s+for\s+write\s+IO\s+to\s+PST\s+disk", re.I)

# Disk group structural changes (CREATE/DROP) — Oracle echoes the
# executed SQL/ASMCMD command back as "SUCCESS: <command text>" (confirmed
# real wording, e.g. "SUCCESS: /* ASMCMD */ALTER DISKGROUP data CHECK
# NOREPAIR"). MOUNT/DISMOUNT already have their own dedicated patterns
# above; this catches the create/drop lifecycle those don't cover.
ASM_DISKGROUP_CREATE_RE = re.compile(r"SUCCESS:.*\bCREATE\s+DISKGROUP\b", re.I)
ASM_DISKGROUP_DROP_RE = re.compile(r"SUCCESS:.*\bDROP\s+DISKGROUP\b", re.I)

# Disk-repair-timer expiry — "WARNING: PST-initiated drop of N disk(s) in
# group G(.NNNNNNNN))". This is what happens when a disk stays OFFLINE
# (see ASM_DISK_OFFLINE_RE above) longer than its disk_repair_time and ASM
# gives up and permanently drops it — a real, often-missed redundancy-loss
# event that triggers an automatic rebalance. Confirmed exact wording from
# Oracle community/support incident write-ups. Previously only caught
# generically as a plain "WARNING:" line with no distinct category.
ASM_DISK_REPAIR_TIMER_DROP_RE = re.compile(
    r"PST-initiated drop of\s+(\d+)\s+disk\(s\)\s+in\s+group\s+(\d+)", re.I
)

# ---------------- CRS / Grid Infrastructure (Clusterware) Regex Patterns ----------------
# Oracle Clusterware (CRS/GI) alert logs interleave two line shapes:
#   1) "YYYY-MM-DD HH:MM:SS.mmm [COMPONENT(PID)]CRS-NNNNN: message text"
#      — the normal, self-timestamped, self-attributed CRS event line emitted
#        by every clusterware daemon (OHASD, CRSD, OCSSD, CSSD, CRSCTL,
#        ORAAGENT, ORAROOTAGENT, GPNPD, OCTSSD, GIPCD, MDNSD, CVUD, CLSECHO...).
#   2) Bare continuation lines with NO timestamp/component prefix at all —
#      e.g. raw `crsctl`/CVU command output ("CRS-4639: Could not contact
#      Oracle High Availability Services", individual "PRVG-nnnnn : ..."
#      findings) that gets appended verbatim under the CRS-10051 line that
#      triggered it. These must still be captured and timestamped using the
#      most recently seen timestamp, exactly like the main alert-log and ASM
#      parsers already do for their own un-timestamped lines.
CRS_LOG_MARKER_RE = re.compile(
    r"\[OHASD\(|\[CRSD\(|\[OCSSD\(|\[CSSD\(|\[GPNPD\(|\[MDNSD\(|\[GIPCD\(|\[OCTSSD\(|"
    r"\[CRSCTL\(|\[ORAAGENT\(|\[ORAROOTAGENT\(|\[CVUD\(|\bCRS-\d{4,6}\b|"
    r"Oracle Clusterware (?:OHASD|CRSD)? ?process|Cluster Ready Service",
    re.I
)

# Header shape shared by every self-attributed CRS log line. Accepts both the
# space-separated CRS timestamp ("2026-08-10 10:05:58.030") and, defensively,
# an ISO "T" separated one, in case a future GI version changes formatting.
CRS_HEADER_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\.\d+(?:[+\-]\d{2}:\d{2})?)\s*"
    r"\[(?P<comp>[A-Za-z_]+)\((?P<pid>\d+)\)\](?P<msg>.*)$"
)

# Any CRS-coded line at all — the future-proofing safety net for THIS parser.
# Every line that contains a CRS-NNNNN code gets an event row no matter what,
# even if none of the specific category regexes below recognize it (a brand
# new GI version / a code this tool has no dedicated rule for yet).
CRS_CODE_RE = re.compile(r"\bCRS-(\d{4,6}):?\s*(.*)")

# Related Oracle prerequisite/verification code families that show up
# embedded inside (or right after) CRS-10051 "CVU found following errors"
# blocks — captured as their own findings so nothing inside those blocks is
# silently dropped.
CVU_CODE_RE = re.compile(r"\b(PRVG|PRVF|PRCT|PRVH|PRCI|PRCR|PRCC|PRKO)-(\d{3,6})\b")

# PRKC/PRKN — SRVCTL/CVU node-connectivity & remote-command prerequisite
# checks (e.g. "PRKC-1191: Remote command execution setup check ... failed",
# "PRKN-1035: Host ... is unreachable"). Confirmed at real, recurring volume
# in this environment's own CRS log (paired with an SSH "Permission denied"
# line) — an SSH/node-reachability problem serious enough to block cluster
# operations, so it deserves its own category rather than sitting in the
# generic "Unclassified / New Pattern" bucket.
CRS_SSH_CONNECTIVITY_RE = re.compile(r"\b(PRKC|PRKN)-(\d{3,6})\b")

# ACFS (ASM Cluster File System) / AFD (ASM Filter Driver) install & runtime
# messages — a distinct, high-volume message family in real GI logs.
CRS_ACFS_AFD_RE = re.compile(r"\b(ACFS|AFD)-(\d{3,6})\b")

# --- Clusterware daemon startup ---
CRS_PROC_STARTING_RE = re.compile(
    r"Oracle Clusterware (\S+) process is starting with operating system process ID\s*(\d+)", re.I)
CRS_RELEASE_RE = re.compile(r"Oracle Clusterware Release\s+([\d.]+)", re.I)
CRS_CSSD_STARTED_RE = re.compile(r"CSSD daemon is started in (\S+) mode", re.I)
CRS_CSSD_READY_RE = re.compile(r"Cluster Synchronization Services daemon \(CSSD\) is ready for operation", re.I)
CRS_OCR_STARTED_RE = re.compile(r"The OCR service started on node\s+(\S+)", re.I)
CRS_OLR_STARTED_RE = re.compile(r"The OLR service started on node\s+(\S+)", re.I)
CRS_TIMESYNC_STARTED_RE = re.compile(r"Cluster Time Synchronization Service started on host\s+(\S+)", re.I)
CRS_GPNPD_STARTED_RE = re.compile(r"Grid Plug and Play Daemon\(?GPNPD\)?\s*started on node\s+(\S+)", re.I)
CRS_CSSD_RECONFIG_COMPLETE_RE = re.compile(r"CSSD Reconfiguration complete\.?\s*Active nodes are\s*(.*)", re.I)

# --- Clusterware daemon / cluster shutdown ---
CRS_SHUTDOWN_START_RE = re.compile(
    r"Starting shutdown of Oracle High Availability Services-managed resources on\s*'([^']+)'", re.I)
CRS_SHUTDOWN_COMPLETE_RE = re.compile(
    r"Shutdown of Oracle High Availability Services-managed resources on\s*'([^']+)'\s*has completed", re.I)
CRS_CSSD_SHUTDOWN_RE = re.compile(r"CSSD on node\s+(\S+)\s+has been shut down", re.I)
CRS_GPNPD_SHUTDOWN_RE = re.compile(r"Grid Plug and Play Daemon\(?GPNPD\)?\s*on node\s+(\S+)\s+shut down", re.I)
CRS_TIMESYNC_SHUTDOWN_RE = re.compile(
    r"Cluster Time Synchronization Service on host\s+(\S+)\s+is shutdown by user", re.I)
CRS_PROC_EXITING_RE = re.compile(
    r"Oracle Clusterware (\S+) process(?: with operating system process ID\s*\d+)? is exiting", re.I)
CRS_MDNS_STOPPING_RE = re.compile(r"mDNS service stopping by request", re.I)

# --- Node eviction / fencing / reboot advisory — HIGHEST severity ---
CRS_FENCE_REQUEST_RE = re.compile(
    r"Fence request issued for an entity node\s*(\S+)(?:\s+with a timeout of\s*(\d+))?", re.I)
CRS_NODE_SHUTDOWN_RE = re.compile(r"Node\s+(\S+),\s*number\s*(\d+),\s*was shut down", re.I)
CRS_NODE_EVICT_RE = re.compile(
    r"Node\s+\S+\s+is being evicted|This node was evicted|"
    r"going down to preserve cluster integrity|"
    r"is unable to communicate with other nodes|"
    r"Evicting node|Split[- ]?brain", re.I)
CRS_REBOOT_ADVISORY_RE = re.compile(
    r"reboot advisory log files,\s*(\d+)\s*were announced\s+and\s+(\d+)\s*errors occurred", re.I)

# --- Node down / cluster membership / server pool ---
CRS_NODE_DOWN_RE = re.compile(r"Node down event reported for node\s*'([^']+)'", re.I)
CRS_SERVER_POOL_ASSIGN_RE = re.compile(r"Server\s*'([^']+)'\s*has been assigned to pool\s*'([^']+)'", re.I)
CRS_SERVER_POOL_REMOVE_RE = re.compile(r"Server\s*'([^']+)'\s*has been removed from pool\s*'([^']+)'", re.I)

# --- OCR / OLR / Voting — cluster registry & quorum, CRITICAL when it fails ---
CRS_OCR_CRITICAL_RE = re.compile(
    r"OCR location.*inaccessible|"
    r"aborted due to Oracle Cluster Registry error|"
    r"Oracle Cluster Registry.*(?:error|corrupt|unavailable)|"
    r"Insufficient quorum to open OCR devices", re.I)
CRS_VOTING_DISK_RISK_RE = re.compile(
    r"[Vv]oting (?:disk|file)s?.*(?:not mounted|offline|inaccessible|lost|below.*quorum)|"
    r"Unable to communicate with (?:one or more )?voting (?:disk|file)s?|"
    # CRS-1606: "number of voting files available, N, is less than the
    # minimum number of voting files required" — doesn't use any of the
    # wording above, but is one of the most severe voting-disk messages
    # there is: it directly precedes CSSD termination to protect data
    # integrity. Confirmed against real Oracle Clusterware alert logs.
    r"number of voting files available.*is less than the minimum", re.I)

# --- Agent / resource start-stop-check failures ---
CRS_AGENT_FAIL_RE = re.compile(
    r"Agent\s*\"?\S*\"?\s*failed to start process|"
    r"Agent\s*\"?\S*\"?\s*timed out starting process|"
    r"Check of resource\s*\"[^\"]+\"\s*failed|"
    r"The resource action\s*\"[^\"]+\"\s*encountered the following error|"
    r"spawned by agent\s*\"[^\"]+\"\s*for action\s*\"[^\"]+\"\s*failed|"
    r"Aborted command\s*'[^']+'\s*for resource\s*'[^']+'|"
    r"Agent\s*'[^']+'\s*disconnected from server|"
    r"Could not start agent", re.I)
CRS_RESOURCE_STATE_RE = re.compile(
    r"Attempting to (?:start|stop)\s*'([^']+)'|"
    r"(?:Start|Stop) of\s*'([^']+)'\s*(?:on member\s*'[^']+'\s*)?(?:succeeded|failed)", re.I)

# --- Network / interconnect ---
CRS_NETWORK_ISSUE_RE = re.compile(
    r"failed to identify the Fast Node Death Detection|"
    r"disabled an IP route associated with destination|"
    r"[Nn]etwork communication with node.*(?:missing|lost)|"
    r"[Ii]nterconnect.*(?:down|lost|missing|unavailable)|"
    r"misconfigured|"
    # No network interfaces matching the configured cluster_interconnects /
    # public network definition were found on the node (CRS-42216) —
    # confirmed at real volume (hundreds of occurrences) in this
    # environment's own CRS log; previously fell into the generic,
    # unhelpful "CRS Info" bucket since it doesn't contain any of the
    # fail/error/timeout keywords the catch-all bucket looks for.
    r"No interfaces are configured on the local node|"
    # Node-to-node interconnect health check flagging a communication
    # problem without using the word "lost"/"missing" (CRS-7503).
    r"observed communication issues between node", re.I)

# --- Cluster Verification Utility (CVU) findings ---
CRS_CVU_HEADER_RE = re.compile(r"CVU found following errors with Clusterware setup", re.I)

# --- Time Sync Service (non startup/shutdown states, e.g. observer mode) ---
CRS_TIMESYNC_OBSERVER_RE = re.compile(
    r"Cluster Time Synchronization Service on host\s+(\S+)\s+is in observer mode", re.I)

# Generic node-name fallback extractor used when a category matched but had
# no dedicated capture group for the node name.
CRS_NODE_FALLBACK_RE = re.compile(r"\bnode\s+['\"]?([A-Za-z0-9_\-\.]+)['\"]?", re.I)

# Keyword heuristics used ONLY for the generic "CRS Event" catch-all bucket
# (i.e. a CRS-NNNNN code matched CRS_CODE_RE but none of the specific,
# named category regexes above recognized it) so a future/unknown CRS code
# still gets a sensible severity instead of an unlabeled row.
CRS_GENERIC_ERROR_KEYWORDS_RE = re.compile(
    r"\b(fail|failed|failure|error|abort|aborted|unable|could not|cannot|lost|"
    r"corrupt|timeout|timed out|denied|critical|panic|terminat)\b", re.I)
CRS_GENERIC_WARN_KEYWORDS_RE = re.compile(
    r"\b(warning|not mounted|inconsistent|missing|disabled|deprecated|retry|retrying|incomplete)\b", re.I)

# ---------------- Listener Log (TNSLSNR) Regex Patterns ----------------
# Oracle's listener.log uses a distinct, semi-structured line shape — NOT
# the free-text alert-log format every parser above is built for:
#   DD-MON-YYYY HH:MI:SS * <CONNECT_DATA/ADDRESS/command fields...> * <return_code>
# Real production listener logs in this environment also interleave a
# separate ISO-8601-only timestamp line before groups of classic lines (an
# artifact of whatever tool is tailing/shipping the file) — those carry no
# event data of their own and are treated as timestamp context only.
LISTENER_ISO_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[\+\-]\d{2}:\d{2}\s*$")
LISTENER_LINE_RE = re.compile(r"^(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2})\s*\*\s*(.*)$", re.I)

# Auto-detection: the classic "DD-MON-YYYY HH:MI:SS * ... * <digits>" line
# shape is extremely distinctive to listener.log, as is the startup banner
# every listener.log begins with — either is sufficient to identify the file.
LISTENER_LOG_MARKER_RE = re.compile(
    r"^\d{2}-[A-Z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}\s*\*.*\*\s*\d+\s*$|"
    r"TNSLSNR for .*?Version|Listening on:\s*\(DESCRIPTION", re.I
)

# Startup / banner lines (no leading DD-MON-YYYY timestamp of their own)
LISTENER_BANNER_START_RE = re.compile(r"TNSLSNR for .*?Version\s+([\d.]+)", re.I)
LISTENER_LISTENING_ON_RE = re.compile(r"Listening on:\s*(\(DESCRIPTION=.*\))", re.I)
LISTENER_STARTED_PID_RE = re.compile(r"Started with pid\s*=\s*(\d+)", re.I)
LISTENER_CRS_NOTIFY_RE = re.compile(r"Listener completed notification to CRS on (start|stop)", re.I)

# Field extractors, applied to a single (CONNECT_DATA=...) or (ADDRESS=...)
# field's text only — never to the whole line — so e.g. the client HOST
# inside CONNECT_DATA's CID is never confused with the ADDRESS block's HOST
# (the peer IP actually carrying the TCP/TCPS connection).
_LSNR_HOST_RE = re.compile(r"HOST=([^)]*)")
_LSNR_USER_RE = re.compile(r"USER=([^)]*)")
_LSNR_PROGRAM_RE = re.compile(r"PROGRAM=([^)]*)")
_LSNR_SERVICE_NAME_RE = re.compile(r"SERVICE_NAME=([^)]*)")
_LSNR_SERVICE_ONLY_RE = re.compile(r"\bSERVICE=([^)]*)")
_LSNR_COMMAND_RE = re.compile(r"\bCOMMAND=([^)]*)")
_LSNR_INSTANCE_RE = re.compile(r"INSTANCE_NAME=([^)]*)")
_LSNR_PORT_RE = re.compile(r"PORT=([^)]*)")
_LSNR_PROTOCOL_RE = re.compile(r"PROTOCOL=([^)]*)")
_LSNR_KEY_RE = re.compile(r"\bKEY=([^)]*)")  # IPC/BEQ protocol local connections have no HOST/PORT, only KEY=

# A continuation/detail line immediately following a non-zero return-code
# entry — normally "TNS-nnnnn: <message>", but NL-/NZ-/SSL- (Oracle Net
# native services / crypto / wallet layer) codes also appear on SSL/TCPS
# failures, so the prefix itself is matched generically rather than
# hardcoding "TNS".
LISTENER_ERROR_CODE_LINE_RE = re.compile(r"^\s*([A-Z]{2,4})-(\d{3,6}):\s*(.*)$")

# lsnrctl administrative/control commands — these change listener state or
# configuration and always deserve high visibility regardless of outcome.
LISTENER_ADMIN_COMMANDS = {
    "save_config", "trc_level", "debug", "relocate", "trace", "spawn",
    "set_displaymode", "set_log_directory", "set_log_file", "set_trc_directory",
    "set_trc_file", "set_rawmode", "set_current_listener", "set_password",
    "set_inbound_connect_timeout", "set_connect_timeout", "set_snmp_visible",
    "set_startup_waittime", "set_save_config_on_stop", "set_log_status",
    "change_password",
}
LISTENER_INFO_COMMANDS = {"version", "services", "help", "ping", "log_status", "show", "service"}

# Well-known TNS- error codes seen in listener.log, with a short description
# and severity bucket. Deliberately NOT exhaustive — anything not listed
# here is still fully captured (Error Code + raw detail line), just without
# a friendly description; see the future-proofing safety net further down.
TNS_ERROR_INFO = {
    "00505": ("Connect failed because target host or object does not exist", "Critical"),
    "00507": ("Connection closed", "Warning"),
    "00530": ("Protocol adapter error", "Critical"),
    "00542": ("SSL Handshake failed", "Warning"),
    "01150": ("Missing or invalid TNS listener address", "Critical"),
    "01169": ("Net service name resolves to multiple addresses/protocol mismatch", "Warning"),
    "01189": ("The listener could not authenticate the user", "Critical"),
    "01201": ("Listener could not execute the SET command", "Warning"),
    "12500": ("TNS:listener failed to start a dedicated server process", "Critical"),
    "12502": ("TNS:listener received no CONNECT_DATA from client", "Warning"),
    "12504": ("TNS:listener was not given the SERVICE_NAME in CONNECT_DATA", "Warning"),
    "12505": ("TNS:listener does not currently know of SID given in connect descriptor", "Critical"),
    "12506": ("TNS:listener rejected connection based on service ACL filtering", "Critical"),
    "12508": ("TNS:listener could not resolve the COMMAND given", "Warning"),
    "12509": ("TNS:listener failed to redirect client to service handler", "Critical"),
    "12510": ("TNS:database temporarily lacks resources to handle the request", "Warning"),
    "12511": ("TNS:service handler found but it is not accepting connections", "Warning"),
    "12514": ("TNS:listener does not currently know of service requested in connect descriptor", "Critical"),
    "12516": ("TNS:listener could not find available handler with matching protocol stack", "Critical"),
    "12518": ("TNS:listener could not hand off client connection", "Critical"),
    "12519": ("TNS:no appropriate service handler found", "Critical"),
    "12520": ("TNS:listener could not find available handler for requested type of server", "Critical"),
    "12523": ("TNS:listener could not find instance appropriate for the client connection", "Critical"),
    "12528": ("TNS:listener: all appropriate instances are blocking new connections", "Critical"),
    "12529": ("TNS:listener: all appropriate instances are in restricted mode", "Warning"),
    "12533": ("TNS:illegal ADDRESS parameters", "Warning"),
    "12535": ("TNS:operation timed out", "Warning"),
    "12536": ("TNS:operation would block", "Info"),
    "12537": ("TNS:connection closed", "Warning"),
    "12541": ("TNS:no listener", "Critical"),
    "12545": ("Connect failed because target host or object does not exist", "Critical"),
    "12547": ("TNS:lost contact", "Warning"),
    "12549": ("TNS:operating system resource quota exceeded", "Critical"),
    "12550": ("TNS:operating system resource quota exceeded", "Critical"),
    "12560": ("TNS:protocol adapter error", "Critical"),
    "12564": ("TNS:connection refused", "Warning"),
    "12570": ("TNS:packet reader failure", "Warning"),
    "12571": ("TNS:packet writer failure", "Warning"),
    "12599": ("TNS:cryptographic checksum mismatch", "Critical"),
    "12606": ("TNS:Application timeout occurred", "Warning"),
    "12609": ("TNS:Receive timeout occurred", "Warning"),
    "12637": ("Packet receive failed", "Warning"),
    "12649": ("Unknown encryption or data integrity algorithm", "Critical"),
    "28860": ("SSL3/TLS handshake failed", "Critical"),
    # --- Added after cross-referencing Oracle Net Services documentation ---
    # (16 Troubleshooting Oracle Net Services / Networking Error Messages).
    # These were previously still captured (Error Code + raw line, via the
    # future-proofing safety net) but showed no friendly description.
    "00510": ("Internal limit restriction exceeded", "Warning"),
    "00516": ("Permission denied", "Critical"),
    "00519": ("Operating system resource quota exceeded", "Critical"),
    "12521": ("TNS:listener does not currently know of instance requested in connect descriptor", "Critical"),
    "12525": ("TNS:listener has not received client's request in time allowed", "Warning"),
    "12540": ("TNS:internal limit restriction exceeded", "Warning"),
    "12546": ("TNS:permission denied", "Critical"),
    "12548": ("TNS:incomplete read or write", "Warning"),
    "12551": ("TNS:missing keyword", "Warning"),
    "12552": ("TNS:operation was interrupted", "Warning"),
    "12554": ("TNS:current operation still in progress", "Info"),
    "12556": ("TNS:no caller", "Warning"),
    "12557": ("TNS:protocol adapter not loadable", "Critical"),
    "12558": ("TNS:protocol adapter not loaded", "Critical"),
    "12561": ("TNS:unknown error", "Warning"),
    "12562": ("TNS:bad global handle", "Warning"),
    "12566": ("TNS:protocol error", "Warning"),
    "12569": ("TNS:packet checksum failure", "Critical"),
    "12574": ("TNS:redirection denied", "Warning"),
    "12582": ("TNS:invalid operation", "Warning"),
}

# TNS codes that represent an EXPLICIT security control blocking a client
# (as opposed to a routine connectivity failure) — flagged as a security
# alert on every single occurrence, not just after crossing the repeat
# threshold, since even one ACL rejection or auth failure is worth a look.
LISTENER_ACL_REJECTION_CODES = {"12506"}

# A burst of failed connection attempts from the SAME source IP/host is the
# single highest-value security signal a listener log can carry — repeated
# SSL/TNS failures from one address typically mean a scanner, an
# unauthorized/misconfigured client, or an expired certificate hammering
# the listener. This threshold drives the post-parse aggregation below.
LISTENER_REPEAT_FAILURE_THRESHOLD = 5


def is_listener_log(lines, sample_size=300):
    """Heuristically detect a TNSLSNR (listener.log / SCAN listener log) file."""
    checked = 0
    for line in lines:
        if LISTENER_LOG_MARKER_RE.search(line):
            return True
        checked += 1
        if checked >= sample_size:
            break
    return False


def _listener_split_fields(remainder):
    """Split a listener.log line's remainder (everything after the leading
    DD-MON-YYYY timestamp) on ' * ', WITHOUT ever splitting inside a
    parenthesised (CONNECT_DATA=...)/(ADDRESS=...) field — those fields are
    long and structured but must stay as one single field."""
    fields, buf, depth = [], [], 0
    i, n = 0, len(remainder)
    while i < n:
        ch = remainder[i]
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif depth == 0 and remainder[i:i + 3] == " * ":
            fields.append("".join(buf).strip())
            buf = []
            i += 3
            continue
        else:
            buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        fields.append(tail)
    return fields


def _listener_extract(pattern, text):
    if not text:
        return None
    m = pattern.search(text)
    return m.group(1) if m else None


def analyze_listener_log_lines(lines, source_name="uploaded"):
    """Parse an Oracle Net Listener log (listener.log or a SCAN/node listener
    log — LISTENER_SCAN1/2/3, node listeners, etc; all share the same format).

    Returns (connection_events, security_events, unclassified_events):
      - connection_events: one row per parsed listener line — connection
        establish/refuse, service registration & health (service_update /
        service_register / service_died), status polls, admin/control
        commands, and the listener startup banner. This is the full audit
        trail, exactly like the ORA/Warning rows the main alert-log parser
        produces.
      - security_events: post-processed, higher-signal alerts built on top
        of connection_events — repeated-failure bursts from one source,
        unknown-service/SID probing (TNS-12505/12514), authentication
        failures (TNS-01189), and listener stop/reload commands — the
        "look here first" list for a DBA/security reviewer.
      - unclassified_events: any line matching the listener line shape whose
        command this parser has no specific rule for yet, PLUS any stray
        PREFIX-NNNNN error code or high-signal keyword found on a
        continuation/detail line. Same future-proofing safety net used by
        the RDBMS/ASM/CRS parsers above (GENERIC_ERROR_CODE_RE /
        GENERIC_SEVERITY_RE) — so a brand-new TNS/NL/NZ code, or any error
        text this tool has never seen before, is still surfaced instead of
        being silently dropped. This is what keeps the analyzer accurate on
        production traffic patterns beyond the limited sample logs used to
        build it.
    """
    events = []
    unclassified_events = []
    current_iso_ts = None  # from the interleaved ISO-only marker lines, if present

    n = len(lines)
    i = 0
    while i < n:
        raw_line = lines[i]
        line = raw_line.rstrip("\n")
        if not line.strip():
            i += 1
            continue

        if LISTENER_ISO_ONLY_RE.match(line):
            current_iso_ts = line.strip()
            i += 1
            continue

        m = LISTENER_LINE_RE.match(line)
        if not m:
            stripped = line.strip()

            # Startup banner lines (no DD-MON-YYYY prefix of their own) —
            # captured as their own event rather than silently merged into
            # whatever event happened to precede them.
            if (LISTENER_BANNER_START_RE.search(stripped) or LISTENER_LISTENING_ON_RE.search(stripped)
                    or LISTENER_STARTED_PID_RE.search(stripped) or LISTENER_CRS_NOTIFY_RE.search(stripped)):
                events.append({
                    "Timestamp": current_iso_ts or (events[-1]["Timestamp"] if events else "Not Found"),
                    "Event Type": "Listener Startup", "Command": "-", "Service": "-",
                    "Client Host": "-", "Client IP": "-", "Program": "-", "User": "-",
                    "Return Code": "-", "Error Code": None, "Detail": stripped,
                    "Source": source_name, "Raw Line": line,
                })
                i += 1
                continue

            # Otherwise this is a continuation/detail line trailing the
            # PREVIOUS event — a "TNS-nnnnn: <message>" error explanation,
            # an OS-level error line, or an informational follow-up (e.g.
            # "Dynamic address is already listened on ..."). Fold it into
            # that event's Detail instead of dropping it.
            if events:
                err_m = LISTENER_ERROR_CODE_LINE_RE.match(stripped)
                if err_m:
                    full_code = f"{err_m.group(1)}-{err_m.group(2)}"
                    extra = f"{full_code}: {err_m.group(3)}".strip()
                    if not events[-1]["Error Code"]:
                        events[-1]["Error Code"] = full_code
                    if extra and extra not in events[-1]["Detail"]:
                        events[-1]["Detail"] = (events[-1]["Detail"] + " | " + extra) if events[-1]["Detail"] else extra
                elif stripped and stripped not in events[-1]["Detail"]:
                    events[-1]["Detail"] = (events[-1]["Detail"] + " | " + stripped) if events[-1]["Detail"] else stripped

            # Future-proofing safety net — also run on continuation lines,
            # so a brand-new error prefix/severity phrase on a detail line
            # is never silently lost.
            code_m = GENERIC_ERROR_CODE_RE.search(stripped)
            ts_fallback = events[-1]["Timestamp"] if events else (current_iso_ts or "Not Found")
            if code_m and code_m.group(1).split("-")[0] not in GENERIC_ERROR_CODE_SKIP_PREFIXES:
                unclassified_events.append({
                    "Timestamp": ts_fallback, "Match Type": "Unmapped Error Code (Listener)",
                    "Matched": code_m.group(1), "Source": source_name, "Raw Line": stripped,
                })
            else:
                sev_m = GENERIC_SEVERITY_RE.search(stripped)
                if sev_m:
                    unclassified_events.append({
                        "Timestamp": ts_fallback, "Match Type": "Possible Severity Keyword (Listener)",
                        "Matched": sev_m.group(1).upper(), "Source": source_name, "Raw Line": stripped,
                    })
            i += 1
            continue

        ts_str, remainder = m.group(1), m.group(2)
        fields = _listener_split_fields(remainder)
        if not fields:
            i += 1
            continue

        last = fields[-1]
        return_code = last if last.isdigit() else None
        structured = [f for f in fields if f.startswith("(")]
        plain = [f for f in fields if not f.startswith("(") and f != return_code]

        connect_data = next((f for f in structured if f.upper().startswith("(CONNECT_DATA")), None)
        address = next((f for f in structured if f.upper().startswith("(ADDRESS")), None)

        command = plain[0] if plain else None
        service_field = plain[1] if len(plain) > 1 else None

        client_host = _listener_extract(_LSNR_HOST_RE, connect_data)
        client_user = _listener_extract(_LSNR_USER_RE, connect_data)
        program = _listener_extract(_LSNR_PROGRAM_RE, connect_data)
        cd_command = _listener_extract(_LSNR_COMMAND_RE, connect_data)
        instance_name = _listener_extract(_LSNR_INSTANCE_RE, connect_data)
        service_name = (_listener_extract(_LSNR_SERVICE_NAME_RE, connect_data)
                         or _listener_extract(_LSNR_SERVICE_ONLY_RE, connect_data)
                         or service_field or instance_name)
        client_ip = _listener_extract(_LSNR_HOST_RE, address)
        client_port = _listener_extract(_LSNR_PORT_RE, address)
        protocol = _listener_extract(_LSNR_PROTOCOL_RE, address)
        # IPC/BEQ (local, same-machine) connections have no HOST/PORT at
        # all — only a KEY= identifier. Fall back to it so local
        # connections aren't shown as blank "-" in Client IP.
        if not client_ip:
            client_ip = _listener_extract(_LSNR_KEY_RE, address)

        row = {
            "Timestamp": ts_str, "Event Type": "Unclassified",
            "Command": command or cd_command or "-",
            "Service": service_name or "-",
            "Client Host": client_host or "-",
            "Client IP": client_ip or "-", "Client Port": client_port or "-",
            "Program": program or "-", "User": client_user or "-",
            "Protocol": (protocol or "-").upper(),
            "Return Code": return_code or "-", "Error Code": None, "Detail": "",
            "Source": source_name, "Raw Line": line,
        }

        rc_is_error = return_code not in (None, "0")

        if command == "establish":
            row["Event Type"] = "Connection Refused/Error" if rc_is_error else "Connection Established"
        elif command in ("<unknown connect data>", "refuse"):
            row["Event Type"] = "Connection Refused/Error"
        elif command == "status":
            row["Event Type"] = "Status Check"
        elif command == "service_update":
            row["Event Type"] = "Service Update"
        elif command and command.startswith("service_register"):
            row["Event Type"] = "Service Registered"
        elif command == "service_died":
            # Always high-signal regardless of the accompanying code — a
            # registered service instance dropped its listener registration
            # connection (instance bounce, PMON registration timeout, or a
            # network blip all show up this way).
            row["Event Type"] = "Service Died"
        elif command == "stop":
            row["Event Type"] = "Listener Stop Command"
        elif command == "reload":
            row["Event Type"] = "Listener Reload Command"
        elif command in LISTENER_ADMIN_COMMANDS:
            row["Event Type"] = "Admin Command"
        elif command in LISTENER_INFO_COMMANDS:
            row["Event Type"] = "Status Check"
        elif command:
            row["Event Type"] = "Other Command"

        if rc_is_error:
            rc_padded = return_code.zfill(5)
            desc, sev = TNS_ERROR_INFO.get(rc_padded, ("Unrecognized/undocumented TNS error code — review the raw line and any detail below.", "Warning"))
            row["Error Code"] = f"TNS-{rc_padded}"
            row["Detail"] = f"TNS-{rc_padded}: {desc}"
            # Escalate unknown-service/SID probing, ACL rejections, and
            # auth failures to their own security-relevant event types so
            # they surface separately from generic "Connection
            # Refused/Error" noise.
            if rc_padded in LISTENER_ACL_REJECTION_CODES:
                row["Event Type"] = "Access Denied (ACL)"
            elif rc_padded in {"12505", "12514"} and row["Event Type"] == "Connection Refused/Error":
                row["Event Type"] = "Unknown Service/SID Requested"
            elif rc_padded == "01189":
                row["Event Type"] = "Authentication Failure"

        events.append(row)
        i += 1

    # ---- Post-process: security-relevant alert aggregation ----
    security_events = []
    fail_types = {"Connection Refused/Error", "Unknown Service/SID Requested", "Authentication Failure", "Access Denied (ACL)"}
    by_source = {}
    for e in events:
        if e["Event Type"] in fail_types:
            key = e["Client IP"] if e["Client IP"] != "-" else e["Client Host"]
            by_source.setdefault(key, []).append(e)

    for src, evs in by_source.items():
        if src == "-" or len(evs) < LISTENER_REPEAT_FAILURE_THRESHOLD:
            continue
        codes = sorted({e["Error Code"] for e in evs if e["Error Code"]})
        security_events.append({
            "Timestamp": evs[0]["Timestamp"], "Alert Type": "Repeated Connection Failures From Single Source",
            "Source Host/IP": src, "Occurrences": len(evs),
            "Error Codes": ", ".join(codes) if codes else "-",
            "First Seen": evs[0]["Timestamp"], "Last Seen": evs[-1]["Timestamp"],
            "Source": source_name,
            "Detail": (f"{len(evs)} failed connection attempt(s) from {src} — possible port scan, "
                       f"expired/misconfigured client certificate, or unauthorized probing."),
        })

    for e in events:
        if e["Event Type"] in {"Authentication Failure", "Unknown Service/SID Requested", "Access Denied (ACL)"}:
            # Every single occurrence is reported — even one ACL rejection
            # or auth failure is a deliberate security control firing and
            # is worth a DBA/security reviewer's attention, not just bursts.
            security_events.append({
                "Timestamp": e["Timestamp"], "Alert Type": e["Event Type"],
                "Source Host/IP": e["Client IP"] if e["Client IP"] != "-" else e["Client Host"],
                "Occurrences": 1, "Error Codes": e["Error Code"] or "-",
                "First Seen": e["Timestamp"], "Last Seen": e["Timestamp"],
                "Source": source_name, "Detail": e["Detail"] or e["Raw Line"],
            })
        elif e["Event Type"] in {"Listener Stop Command", "Listener Reload Command"}:
            security_events.append({
                "Timestamp": e["Timestamp"], "Alert Type": e["Event Type"],
                "Source Host/IP": e["Client IP"] if e["Client IP"] != "-" else e["Client Host"],
                "Occurrences": 1, "Error Codes": "-",
                "First Seen": e["Timestamp"], "Last Seen": e["Timestamp"],
                "Source": source_name,
                "Detail": f"{e['Command']} issued from host={e['Client Host']} user={e['User']} program={e['Program']} — verify this was planned maintenance.",
            })
        elif e["Event Type"] == "Service Died":
            security_events.append({
                "Timestamp": e["Timestamp"], "Alert Type": "Service Died",
                "Source Host/IP": "-", "Occurrences": 1, "Error Codes": e["Error Code"] or "-",
                "First Seen": e["Timestamp"], "Last Seen": e["Timestamp"],
                "Source": source_name,
                "Detail": f"Service '{e['Service']}' lost its listener registration — check instance/PMON health.",
            })

    return events, security_events, unclassified_events


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

        m = ASM_DISK_REPAIR_TIMER_DROP_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "Disk Repair Timer Expired (Forced Drop)",
                            "Diskgroup": f"group {m.group(2)}",
                            "Detail": f"{m.group(1)} disk(s) permanently dropped after disk_repair_time expired — redundancy reduced, rebalance will follow. {line.strip()}",
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

        # --- Quorum loss / PST heartbeat stall / diskgroup create-drop ---
        # Checked BEFORE the generic ASM_ERROR_RE / WARN_RE catches below so
        # these severe, well-known patterns get their own distinct event
        # type instead of being buried in generic "ASM Error"/"Warning" rows.
        m = ASM_QUORUM_LOSS_RE.search(line)
        if m:
            dg_m = ASM_ORA_DISKGROUP_NAME_RE.search(line)
            events.append({"Timestamp": ts_now, "Event Type": "Quorum Loss (Diskgroup At Risk)",
                            "Diskgroup": dg_m.group(1) if dg_m else "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_PST_IO_WAIT_RE.search(line)
        if m:
            dg_m = ASM_ORA_DISKGROUP_NAME_RE.search(line)
            events.append({"Timestamp": ts_now, "Event Type": "PST Disk I/O Stall",
                            "Diskgroup": dg_m.group(1) if dg_m else "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_DISKGROUP_CREATE_RE.search(line)
        if m:
            dg_m = ASM_ORA_DISKGROUP_NAME_RE.search(line)
            events.append({"Timestamp": ts_now, "Event Type": "Diskgroup Created",
                            "Diskgroup": dg_m.group(1) if dg_m else "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_DISKGROUP_DROP_RE.search(line)
        if m:
            dg_m = ASM_ORA_DISKGROUP_NAME_RE.search(line)
            events.append({"Timestamp": ts_now, "Event Type": "Diskgroup Dropped",
                            "Diskgroup": dg_m.group(1) if dg_m else "-", "Detail": line.strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        m = ASM_ERROR_RE.search(line)
        if m:
            events.append({"Timestamp": ts_now, "Event Type": "ASM Error",
                            "Diskgroup": "-", "Detail": m.group(1).strip(),
                            "Source": source_name, "Raw Line": line})
            continue

        # Plain "WARNING:" lines — previously NOT checked at all in ASM
        # logs. Real validation against this environment's own ASM log
        # found 189 WARNING lines completely invisible before this check
        # existed, including operationally critical ones such as
        # "WARNING: failed to online diskgroup resource ora.DATA_FRS.dg"
        # and "WARNING: Disk Group OCR containing voting files is not
        # mounted" — i.e. quorum/availability risks a DBA must see.
        if WARN_RE.search(line):
            dg_m = ASM_ORA_DISKGROUP_NAME_RE.search(line)
            events.append({"Timestamp": ts_now, "Event Type": "Warning",
                            "Diskgroup": dg_m.group(1) if dg_m else "-",
                            "Detail": line.strip(), "Trace File": find_nearby_trace(i),
                            "Source": source_name, "Raw Line": line})
            continue

        # Notable non-"WARNING"-worded events (see NOTABLE_EVENT_RE above) —
        # TNS/listener "Fatal NI connect error", checkpoint/log-switch
        # stalls, RAC reconfiguration, instance crash/termination, etc.
        # Shared with the main RDBMS parser so an ASM instance's own
        # listener failures or termination events get the same treatment.
        notable_m = NOTABLE_EVENT_RE.search(line)
        if notable_m:
            label = NOTABLE_EVENT_LABELS[notable_m.lastgroup]
            events.append({"Timestamp": ts_now, "Event Type": f"Notable: {label}",
                            "Diskgroup": "-", "Detail": line.strip(),
                            "Trace File": find_nearby_trace(i),
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

def is_crs_log(lines, sample_size=None):
    """Heuristically detect whether a set of log lines belongs to an Oracle
    Clusterware / Grid Infrastructure (CRS) alert log, by scanning for
    CRS-specific markers ([OHASD(...], [CRSD(...], CRS-NNNNN codes, etc).

    Unlike a plain per-node RDBMS or ASM alert log, real-world CRS logs are
    frequently found interleaved with unrelated content (TNS/listener
    connect errors, etc) near the top of the file, with the actual CRS
    events starting much later. Capping the scan to the first few hundred
    lines (as the ASM detector does) would silently MISS the log entirely
    in that situation, so by default this scans the WHOLE file — accuracy
    over speed, per production requirements. Pass an explicit sample_size
    to cap the scan for very large files if needed.
    """
    checked = 0
    for line in lines:
        if CRS_LOG_MARKER_RE.search(line):
            return True
        checked += 1
        if sample_size and checked >= sample_size:
            break
    return False

def analyze_crs_events(lines, source_name="uploaded"):
    """Parse Oracle Clusterware / Grid Infrastructure (CRS) alert log lines
    for daemon startup/shutdown, node eviction & fencing, node membership
    changes, OCR/OLR/voting-disk failures, agent & resource failures,
    network/interconnect issues, Cluster Verification Utility (CVU)
    findings, ACFS/AFD driver messages, and any other CRS-coded event.

    Every single line that carries a CRS-NNNNN (or related PRVG/PRVF/ACFS/
    AFD/...) code is guaranteed to produce a row — named categories get a
    specific, human-readable Event Type; anything this tool doesn't have a
    dedicated rule for yet still lands in a generic 'CRS Event' bucket with
    a best-effort severity, rather than being silently dropped. This keeps
    the analyzer accurate today AND future-proof against new/unseen CRS
    codes, exactly like the existing ORA/ASM parsers above.
    """
    events = []
    unclassified_events = []
    current_timestamp = None
    current_component = "-"
    current_pid = "-"

    def node_of(m, *group_indices):
        for gi in group_indices:
            try:
                val = m.group(gi)
                if val:
                    return val
            except Exception:
                continue
        return "-"

    def fallback_node(text):
        nm = CRS_NODE_FALLBACK_RE.search(text)
        return nm.group(1) if nm else "-"

    def extract_code(text):
        cm = CRS_CODE_RE.search(text)
        if cm:
            return f"CRS-{cm.group(1)}"
        gm = GENERIC_ERROR_CODE_RE.search(text)
        if gm:
            return gm.group(1)
        return "-"

    for i, raw_line in enumerate(lines):
        line = raw_line.rstrip("\n")
        if not line.strip():
            continue

        header_m = CRS_HEADER_RE.match(line)
        if header_m:
            current_timestamp = header_m.group("ts")
            current_component = header_m.group("comp")
            current_pid = header_m.group("pid")
            msg = header_m.group("msg").strip()
        else:
            # Pure timestamp-only separator line (same ISO format used by
            # the surrounding RDBMS-style portion of a mixed log) — just
            # advance the running clock, nothing to classify.
            ts_only_m = TIMESTAMP_RE.fullmatch(line.strip())
            if ts_only_m:
                current_timestamp = ts_only_m.group(1)
                continue
            # Free-standing continuation line (raw crsctl/CVU output,
            # PRVG-nnnnn bullet findings, etc) — no header of its own, but
            # still needs to be captured and attributed to the most
            # recently seen timestamp/component, exactly like the main
            # alert-log parser does for trace-file references.
            msg = line.strip()

        ts_now = current_timestamp or "Not Found"
        comp_now = current_component

        base = {"Timestamp": ts_now, "Component": comp_now, "Source": source_name, "Raw Line": line}

        # 1) Node eviction / fencing / reboot advisory — highest severity,
        #    checked first so it's never masked by a lower-priority match.
        m = CRS_FENCE_REQUEST_RE.search(msg)
        if m:
            timeout_txt = f" (timeout {m.group(2)}ms)" if m.group(2) else ""
            events.append({**base, "Event Type": "Node Eviction / Fencing",
                            "Node": m.group(1), "CRS Code": "CRS-1735",
                            "Detail": f"Fence request issued for node {m.group(1)}{timeout_txt}"})
            continue
        m = CRS_NODE_SHUTDOWN_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Node Eviction / Fencing",
                            "Node": m.group(1), "CRS Code": "CRS-1625",
                            "Detail": f"Node {m.group(1)} (number {m.group(2)}) was shut down"})
            continue
        m = CRS_NODE_EVICT_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Node Eviction / Fencing",
                            "Node": fallback_node(msg), "CRS Code": extract_code(msg),
                            "Detail": msg})
            continue
        m = CRS_REBOOT_ADVISORY_RE.search(msg)
        if m:
            announced, errors = int(m.group(1)), int(m.group(2))
            severity_note = " — ⚠️ reboot WAS announced" if announced > 0 else ""
            events.append({**base, "Event Type": "Node Eviction / Fencing",
                            "Node": "-", "CRS Code": "CRS-8017",
                            "Detail": f"Reboot advisory log check: {announced} announced, {errors} error(s){severity_note}"})
            continue

        # 2) OCR / OLR / voting-disk critical failures
        m = CRS_OCR_CRITICAL_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "OCR/OLR Critical Failure",
                            "Node": fallback_node(msg), "CRS Code": extract_code(msg), "Detail": msg})
            continue
        m = CRS_VOTING_DISK_RISK_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "OCR/OLR Critical Failure",
                            "Node": fallback_node(msg), "CRS Code": extract_code(msg), "Detail": msg})
            continue

        # 3) Node down / cluster membership / server pool changes
        m = CRS_NODE_DOWN_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Node Down / Membership",
                            "Node": m.group(1), "CRS Code": "CRS-5504",
                            "Detail": f"Node down event reported for '{m.group(1)}'"})
            continue
        m = CRS_SERVER_POOL_ASSIGN_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Server Pool Change",
                            "Node": m.group(1), "CRS Code": "CRS-2772",
                            "Detail": f"Server '{m.group(1)}' assigned to pool '{m.group(2)}'"})
            continue
        m = CRS_SERVER_POOL_REMOVE_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Server Pool Change",
                            "Node": m.group(1), "CRS Code": "CRS-2773",
                            "Detail": f"Server '{m.group(1)}' removed from pool '{m.group(2)}'"})
            continue

        # 4) Agent / resource start-stop-check failures
        m = CRS_AGENT_FAIL_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Agent / Resource Failure",
                            "Node": fallback_node(msg), "CRS Code": extract_code(msg), "Detail": msg})
            continue
        m = CRS_RESOURCE_STATE_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Resource State Change",
                            "Node": fallback_node(msg), "CRS Code": extract_code(msg), "Detail": msg})
            continue

        # 5) Network / interconnect issues
        m = CRS_NETWORK_ISSUE_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Network / Interconnect Issue",
                            "Node": fallback_node(msg), "CRS Code": extract_code(msg), "Detail": msg})
            continue

        # 6) Cluster Verification Utility (CVU) findings — both the
        #    triggering CRS-10051 line and every un-prefixed PRVG/PRVF/...
        #    continuation line that follows it.
        m = CRS_CVU_HEADER_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Cluster Verification (CVU) Finding",
                            "Node": fallback_node(msg), "CRS Code": "CRS-10051", "Detail": msg})
            continue
        m = CVU_CODE_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Cluster Verification (CVU) Finding",
                            "Node": fallback_node(msg), "CRS Code": f"{m.group(1)}-{m.group(2)}",
                            "Detail": msg})
            continue
        m = CRS_SSH_CONNECTIVITY_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Node Connectivity / SSH Issue",
                            "Node": fallback_node(msg), "CRS Code": f"{m.group(1)}-{m.group(2)}",
                            "Detail": msg})
            continue

        # 7) Time Sync Service state (non start/stop — e.g. observer mode)
        m = CRS_TIMESYNC_OBSERVER_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Time Sync Service",
                            "Node": m.group(1), "CRS Code": "CRS-2403", "Detail": msg})
            continue

        # 8) Clusterware daemon startup
        m = CRS_PROC_STARTING_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Startup",
                            "Node": "-", "CRS Code": "CRS-8500",
                            "Detail": f"{m.group(1)} process starting (pid {m.group(2)})"})
            continue
        m = CRS_RELEASE_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Startup",
                            "Node": "-", "CRS Code": "CRS-0714", "Detail": msg})
            continue
        m = CRS_CSSD_STARTED_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Startup",
                            "Node": "-", "CRS Code": "CRS-1713", "Detail": msg})
            continue
        m = CRS_CSSD_READY_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Startup",
                            "Node": "-", "CRS Code": "CRS-1720", "Detail": msg})
            continue
        m = CRS_OCR_STARTED_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Startup",
                            "Node": m.group(1), "CRS Code": "CRS-1012", "Detail": msg})
            continue
        m = CRS_OLR_STARTED_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Startup",
                            "Node": m.group(1), "CRS Code": "CRS-2112", "Detail": msg})
            continue
        m = CRS_TIMESYNC_STARTED_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Time Sync Service",
                            "Node": m.group(1), "CRS Code": "CRS-2401", "Detail": msg})
            continue
        m = CRS_GPNPD_STARTED_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Startup",
                            "Node": m.group(1), "CRS Code": "CRS-2328", "Detail": msg})
            continue
        m = CRS_CSSD_RECONFIG_COMPLETE_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Node Down / Membership",
                            "Node": "-", "CRS Code": "CRS-1601",
                            "Detail": f"CSSD reconfiguration complete. Active nodes: {m.group(1).strip()}"})
            continue

        # 9) Clusterware daemon / cluster shutdown
        m = CRS_SHUTDOWN_START_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Shutdown",
                            "Node": m.group(1), "CRS Code": "CRS-2791", "Detail": msg})
            continue
        m = CRS_SHUTDOWN_COMPLETE_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Shutdown",
                            "Node": m.group(1), "CRS Code": "CRS-2793", "Detail": msg})
            continue
        m = CRS_CSSD_SHUTDOWN_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Shutdown",
                            "Node": m.group(1), "CRS Code": "CRS-1603", "Detail": msg})
            continue
        m = CRS_GPNPD_SHUTDOWN_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Shutdown",
                            "Node": m.group(1), "CRS Code": "CRS-2329", "Detail": msg})
            continue
        m = CRS_TIMESYNC_SHUTDOWN_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Time Sync Service",
                            "Node": m.group(1), "CRS Code": "CRS-2405", "Detail": msg})
            continue
        m = CRS_PROC_EXITING_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Shutdown",
                            "Node": "-", "CRS Code": "CRS-8504", "Detail": msg})
            continue
        m = CRS_MDNS_STOPPING_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "Clusterware Shutdown",
                            "Node": "-", "CRS Code": "CRS-5602", "Detail": msg})
            continue

        # 10) ACFS / AFD driver messages
        m = CRS_ACFS_AFD_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "ACFS / AFD Driver",
                            "Node": "-", "CRS Code": f"{m.group(1)}-{m.group(2)}", "Detail": msg})
            continue

        # 10.5) ORA- errors embedded in the CRS log — CRS/GI alert logs are
        # frequently interleaved with output from the ASM instance or GIMR
        # (management repository) database they host, which can log real
        # ORA- errors (e.g. ORA-01034 instance not available, ORA-27101
        # shared memory realm errors) with no CRS-NNNNN code at all.
        # Previously invisible in this parser.
        m = ORA_RE.search(msg)
        if m:
            events.append({**base, "Event Type": "ORA Error", "Node": fallback_node(msg),
                            "CRS Code": f"ORA-{m.group(1)}", "Detail": msg})
            continue

        # 10.6) TNS/Listener and other notable non-CRS-coded events (see
        # NOTABLE_EVENT_RE above). Real CRS/mixed logs interleave enormous
        # volumes of "Fatal NI connect error"/"TNS-nnnnn" lines — commonly
        # the Grid Infrastructure Management Repository (GIMR/MGMTDB)
        # listener being unreachable — that carry no CRS- code and were
        # previously silently dropped in their entirety by this parser
        # (over half a million lines in real validation against this
        # environment's own CRS log). TNS is NOT in
        # GENERIC_ERROR_CODE_SKIP_PREFIXES's exemption for nothing: the
        # exemption assumes something else already handles it — this is
        # that handling, for this parser.
        notable_m = NOTABLE_EVENT_RE.search(msg)
        if notable_m:
            label = NOTABLE_EVENT_LABELS[notable_m.lastgroup]
            events.append({**base, "Event Type": f"Notable: {label}",
                            "Node": fallback_node(msg), "CRS Code": extract_code(msg), "Detail": msg})
            continue

        # 11) Future-proofing safety net #1 — ANY remaining CRS-NNNNN coded
        #     line that none of the named categories above recognized still
        #     gets captured here, with a best-effort severity guess, rather
        #     than being silently dropped. This is what guarantees new/future
        #     CRS codes are never missed even before this tool has a
        #     dedicated rule for them.
        m = CRS_CODE_RE.search(msg)
        if m:
            code = f"CRS-{m.group(1)}"
            body = m.group(2).strip() if m.group(2) else msg
            if CRS_GENERIC_ERROR_KEYWORDS_RE.search(msg):
                etype = "CRS Error"
            elif CRS_GENERIC_WARN_KEYWORDS_RE.search(msg):
                etype = "CRS Warning"
            else:
                etype = "CRS Info"
            events.append({**base, "Event Type": etype,
                            "Node": fallback_node(msg), "CRS Code": code, "Detail": body or msg})
            continue

        # 12) Future-proofing safety net #2 — same generic prefix-code /
        #     severity-keyword net used by the main alert-log & ASM parsers,
        #     for anything with a non-CRS coded prefix (a future PRVx/PRCx/
        #     component code this parser has no dedicated rule for) or a
        #     high-signal plain-English severity phrase with no code at all.
        code_m = GENERIC_ERROR_CODE_RE.search(msg)
        if code_m and code_m.group(1).split("-")[0] not in GENERIC_ERROR_CODE_SKIP_PREFIXES:
            unclassified_events.append({
                "Timestamp": ts_now, "Match Type": "Unmapped Error Code",
                "Matched": code_m.group(1), "Source": source_name, "Raw Line": line.strip(),
            })
            continue
        sev_m = GENERIC_SEVERITY_RE.search(msg)
        if sev_m:
            unclassified_events.append({
                "Timestamp": ts_now, "Match Type": "Possible Severity Keyword",
                "Matched": sev_m.group(1).upper(), "Source": source_name, "Raw Line": line.strip(),
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


def strip_tz_for_excel(df):
    """
    Make a DataFrame safe to write with df.to_excel(...).

    Excel/xlsxwriter cannot store timezone-aware datetimes at all, so every
    tz-aware value must become naive before export.

    The previous version of this helper only handled the case where a
    column had already been coerced by pandas into a uniform
    `datetime64[ns, tz]` dtype (checked via
    `ptypes.is_datetime64_any_dtype`) and called `.dt.tz_localize(None)` on
    it. That works ONLY when every value in the column carries the exact
    same UTC offset.

    Real alert logs don't guarantee that: lines can be parsed with
    different offsets (e.g. a mix of "+05:30" timestamps and lines that had
    no offset at all and got LOCAL_TZ assigned as a fallback in
    parse_iso_timestamp), or a log can genuinely span a DST change or a
    node in a different timezone. Whenever a column's tz-aware datetimes
    don't all share one offset, pandas is unable to represent the column as
    a single `datetime64[ns, tz]` dtype and silently falls back to plain
    Python `object` dtype holding raw `datetime`/`Timestamp` instances.
    `is_datetime64_any_dtype` returns False for that, so the old code's
    tz-strip branch never ran, and xlsxwriter blew up on the first
    tz-aware cell it tried to format — this is exactly the
    "Excel does not support datetimes with timezones" crash on CRS_Events
    (a CRS/mixed log is the most likely place to have inconsistent
    offsets across lines, since it can interleave several components).

    Fix: handle both cases explicitly, per column —
      1. Uniform tz-aware dtype -> vectorised `.dt.tz_localize(None)`.
      2. Object dtype -> strip tzinfo from every individual
         datetime/Timestamp cell (leaving non-datetime cells untouched).
    """
    if df is None or df.empty:
        return df
    df = df.copy()
    for col in df.columns:
        try:
            if ptypes.is_datetime64_any_dtype(df[col]):
                if getattr(df[col].dt, "tz", None) is not None:
                    df[col] = df[col].dt.tz_localize(None)
            elif df[col].dtype == object:
                def _naive(v):
                    if isinstance(v, (pd.Timestamp, datetime)) and getattr(v, "tzinfo", None) is not None:
                        return v.replace(tzinfo=None)
                    return v
                df[col] = df[col].map(_naive)
        except Exception:
            # Never let export formatting break the download — worst case
            # a column is left as-is and Excel shows it as text.
            pass
    return df


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
    df_a_keys_set = set(df_a_keys)
    df_b_keys_set = set(df_b_keys)

    new_in_b = [b for bkey, b in zip(df_b_keys, list_b) if bkey not in df_a_keys_set]

    # ---- Unique in A (missing in B) ----
    new_in_a = [a for akey, a in zip(df_a_keys, list_a) if akey not in df_b_keys_set]

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
    <p style='color: #666; margin-bottom: 1rem;'>Select one or more Oracle RDBMS alert logs, ASM (+ASM) alert logs, CRS/Clusterware alert logs, and/or listener.log files to analyze — all are auto-detected</p>
</div>
""", unsafe_allow_html=True)

uploaded_files = st.file_uploader(
    "Upload Alert Log Files", type=["log","txt","zip"], accept_multiple_files=True,
    label_visibility="collapsed", key=f"file_uploader_{st.session_state.get('_uploader_reset_count', 0)}"
)

_uc1, _uc2 = st.columns([5, 1])
with _uc2:
    if st.button("🔄 Clear / New Analysis", use_container_width=True, help="Removes all currently uploaded files so you can start a fresh analysis"):
        # Bumping this counter changes the file_uploader's `key` above, which
        # Streamlit treats as a brand-new widget instance — the old one
        # (with its previously selected files) is discarded entirely rather
        # than needing each file chip removed by hand.
        st.session_state["_uploader_reset_count"] = st.session_state.get("_uploader_reset_count", 0) + 1
        for _k in ("global_start_date", "global_end_date", "global_start_time", "global_end_time", "_uploaded_file_sig"):
            st.session_state.pop(_k, None)
        st.rerun()

if uploaded_files:
    # Streamlit quirk: once a widget with a given `key` has rendered, its
    # `session_state[key]` value sticks — changing the `default`/`value`
    # argument in code has NO effect on later reruns until that key is
    # cleared. The global date filter's default is computed from the
    # uploaded files' own timestamps, so when a *different* set of files is
    # uploaded, the old date-filter selection (possibly from a totally
    # different log, or the very first "today" fallback) would otherwise
    # keep being reused — silently filtering every row out of every table
    # below Quick Stats. Detect a change in the uploaded file set and drop
    # the stale keys so the date filter recomputes fresh for the new data.
    _file_sig = tuple(sorted((f.name, f.size) for f in uploaded_files))
    if st.session_state.get("_uploaded_file_sig") != _file_sig:
        st.session_state["_uploaded_file_sig"] = _file_sig
        for _k in ("global_start_date", "global_end_date", "global_start_time", "global_end_time"):
            st.session_state.pop(_k, None)

if not uploaded_files:
    st.markdown("""
    <div style='background: white; padding: 3rem; border-radius: 12px; text-align: center; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);'>
        <h2 style='color: #667eea; margin-bottom: 1rem;'>👋 Welcome!</h2>
        <p style='font-size: 1.1rem; color: #666;'>Upload your Oracle RDBMS, ASM, CRS and/or listener log files above to begin analysis</p>
        <p style='color: #999; margin-top: 1rem;'>Supports .log and .txt files (RDBMS, ASM, CRS/Clusterware &amp; TNSLSNR listener logs, all auto-detected) as well as .zip archives</p>
    </div>
    """, unsafe_allow_html=True)
    st.stop()

# ---------------- Cached parsing pipeline ----------------
# Everything here (decoding files, ORA/warning/kill/trace parsing, ASM/CRS/
# listener auto-detection, the instance-summary scan, and building the
# per-category DataFrames) is the expensive part of this app. Streamlit
# reruns the WHOLE script on every single interaction — ticking a checkbox,
# moving the date filter, typing in the search box, clicking a tab — and
# without caching, all of that work was being redone from scratch every
# time, which is why the app felt slow both right after upload and on every
# click afterwards. Wrapping it in @st.cache_data means this only actually
# re-runs when the uploaded files themselves change; every other
# interaction reuses the cached result instantly. Per-file caching (on the
# file's own bytes) also means adding one more file to an existing upload
# doesn't force every previously-uploaded file to be re-parsed.

@st.cache_data(show_spinner=False, max_entries=8)
def _parse_zip_bytes(zip_bytes):
    """Extract .log/.txt members from an uploaded .zip as raw bytes."""
    extracted = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for file_name in z.namelist():
            if file_name.lower().endswith((".log", ".txt")):
                extracted[file_name] = z.open(file_name).read()
    return extracted


@st.cache_data(show_spinner=False, max_entries=64)
def _parse_one_log_file(file_bytes, file_name):
    """Parse a single log file's bytes. Cached per (name, content), so the
    same file is never re-parsed twice, no matter how many times the app
    reruns."""
    lines = file_bytes.decode("utf-8", errors="ignore").splitlines()
    result = {"lines": lines}

    # 📡 Listener Log Auto-Detection & Parsing (checked first — a
    # listener.log has its own dedicated format and never also contains
    # ORA-/ASM/CRS markers, so it's parsed instead of, not in addition to,
    # the RDBMS/ASM/CRS parsers below).
    if is_listener_log(lines):
        l_events, l_security, l_unclassified = analyze_listener_log_lines(lines, source_name=file_name)
        result.update(
            is_listener=True,
            listener_events=l_events,
            listener_security=l_security,
            listener_unclassified=l_unclassified,
        )
        return result

    o, w, k, tr, u = analyze_alert_log_lines(lines, source_name=file_name)
    result.update(ora=o, warnings=w, kill=k, trace=tr, unclassified=u)

    # 💽 ASM Log Auto-Detection & Parsing
    if is_asm_log(lines):
        asm_events, asm_unclassified = analyze_asm_events(lines, source_name=file_name)
        result.update(is_asm=True, asm_events=asm_events, asm_unclassified=asm_unclassified)

    # 🧬 CRS / Grid Infrastructure Log Auto-Detection & Parsing
    if is_crs_log(lines):
        crs_events, crs_unclassified = analyze_crs_events(lines, source_name=file_name)
        result.update(is_crs=True, crs_events=crs_events, crs_unclassified=crs_unclassified)

    return result


@st.cache_data(show_spinner=False, max_entries=8)
def build_dashboard_data(uploaded_files):
    all_raw_lines = []
    per_file_lines = {}
    combined_ora = []
    combined_warnings = []
    combined_kill_sessions = []
    combined_trace_files = []
    combined_unclassified = []
    combined_asm_events = []
    asm_source_files = set()
    combined_crs_events = []
    crs_source_files = set()
    combined_listener_events = []
    combined_listener_security = []
    listener_source_files = set()

    def _merge(parsed, src_name):
        per_file_lines[src_name] = parsed["lines"]
        all_raw_lines.append(f"--- BEGIN FILE: {src_name} ---")
        all_raw_lines.extend(parsed["lines"])
        all_raw_lines.append(f"--- END FILE: {src_name} ---")

        if parsed.get("is_listener"):
            listener_source_files.add(src_name)
            combined_listener_events.extend(parsed["listener_events"])
            combined_listener_security.extend(parsed["listener_security"])
            combined_unclassified.extend(parsed["listener_unclassified"])
            return

        combined_ora.extend(parsed["ora"])
        combined_warnings.extend(parsed["warnings"])
        combined_kill_sessions.extend(parsed["kill"])
        combined_trace_files.extend(parsed["trace"])
        combined_unclassified.extend(parsed["unclassified"])

        if parsed.get("is_asm"):
            asm_source_files.add(src_name)
            combined_asm_events.extend(parsed["asm_events"])
            combined_unclassified.extend(parsed["asm_unclassified"])

        if parsed.get("is_crs"):
            crs_source_files.add(src_name)
            combined_crs_events.extend(parsed["crs_events"])
            combined_unclassified.extend(parsed["crs_unclassified"])

    for f in uploaded_files:
        name = f.name

        # 🔥 ZIP FILE SUPPORT
        if name.lower().endswith(".zip"):
            extracted = _parse_zip_bytes(f.getvalue())
            for zname, zbytes in extracted.items():
                parsed = _parse_one_log_file(zbytes, zname)
                _merge(parsed, zname)
            continue

        # Normal .log / .txt files
        parsed = _parse_one_log_file(f.getvalue(), name)
        _merge(parsed, name)

    df_ora_all = pd.DataFrame(combined_ora) if combined_ora else pd.DataFrame(columns=["Timestamp","ORA Error","Trace File","Source","Raw Line","Error Block ID","Full Error Block","Related ORA Codes"])
    df_warn_all = pd.DataFrame(combined_warnings) if combined_warnings else pd.DataFrame(columns=["Timestamp","Category","Warning Message","Trace File","Source","Raw Line"])
    df_kill_all = pd.DataFrame(combined_kill_sessions) if combined_kill_sessions else pd.DataFrame(columns=["Timestamp","SID","Serial#","Reason","Mode","Requestor","Owner","Result","Trace File","Source","Raw Line","Full Block"])
    df_asm_all = pd.DataFrame(combined_asm_events) if combined_asm_events else pd.DataFrame(columns=["Timestamp","Event Type","Diskgroup","Detail","Source","Raw Line"])
    df_crs_all = pd.DataFrame(combined_crs_events) if combined_crs_events else pd.DataFrame(columns=["Timestamp","Event Type","Component","Node","CRS Code","Detail","Source","Raw Line"])
    df_listener_all = pd.DataFrame(combined_listener_events) if combined_listener_events else pd.DataFrame(columns=["Timestamp","Event Type","Command","Service","Client Host","Client IP","Client Port","Program","User","Protocol","Return Code","Error Code","Detail","Source","Raw Line"])
    df_listener_security_all = pd.DataFrame(combined_listener_security) if combined_listener_security else pd.DataFrame(columns=["Timestamp","Alert Type","Source Host/IP","Occurrences","Error Codes","First Seen","Last Seen","Source","Detail"])
    df_unclassified_all = pd.DataFrame(combined_unclassified) if combined_unclassified else pd.DataFrame(columns=["Timestamp","Match Type","Matched","Trace File","Source","Raw Line"])
    df_trace_all = pd.DataFrame(combined_trace_files) if combined_trace_files else pd.DataFrame(columns=["Timestamp","Trace File","Source","Raw Line"])

    for _df in (df_ora_all, df_warn_all, df_kill_all, df_asm_all, df_crs_all,
                df_listener_all, df_listener_security_all, df_unclassified_all, df_trace_all):
        if not _df.empty:
            _df["ParsedTimestamp"] = _df["Timestamp"].apply(parse_iso_timestamp)
        else:
            _df["ParsedTimestamp"] = pd.Series(dtype="datetime64[ns]")

    if not df_trace_all.empty:
        df_trace_all = df_trace_all.sort_values("ParsedTimestamp", na_position="last").reset_index(drop=True)

    # Instance summary / startup / shutdown / crash / ALTER / RESIZE scan —
    # also expensive on big multi-file uploads (it walks every line with
    # several regexes), so it's computed once here instead of on every
    # rerun. Uses the same "no BEGIN/END markers" line set the old inline
    # version used.
    clean_lines = [line for _lines in per_file_lines.values() for line in _lines]
    instance_info = detect_instance_summary_and_events(clean_lines)

    return {
        "all_raw_lines": all_raw_lines,
        "per_file_lines": per_file_lines,
        "combined_ora": combined_ora,
        "combined_warnings": combined_warnings,
        "combined_kill_sessions": combined_kill_sessions,
        "combined_trace_files": combined_trace_files,
        "combined_unclassified": combined_unclassified,
        "combined_asm_events": combined_asm_events,
        "asm_source_files": asm_source_files,
        "combined_crs_events": combined_crs_events,
        "crs_source_files": crs_source_files,
        "combined_listener_events": combined_listener_events,
        "combined_listener_security": combined_listener_security,
        "listener_source_files": listener_source_files,
        "df_ora_all": df_ora_all,
        "df_warn_all": df_warn_all,
        "df_kill_all": df_kill_all,
        "df_asm_all": df_asm_all,
        "df_crs_all": df_crs_all,
        "df_listener_all": df_listener_all,
        "df_listener_security_all": df_listener_security_all,
        "df_unclassified_all": df_unclassified_all,
        "df_trace_all": df_trace_all,
        "instance_info": instance_info,
    }


with st.spinner("📄 Processing uploaded files..."):
    _dashboard_data = build_dashboard_data(tuple(uploaded_files))

all_raw_lines = _dashboard_data["all_raw_lines"]
per_file_lines = _dashboard_data["per_file_lines"]
combined_ora = _dashboard_data["combined_ora"]
combined_warnings = _dashboard_data["combined_warnings"]
combined_kill_sessions = _dashboard_data["combined_kill_sessions"]
combined_trace_files = _dashboard_data["combined_trace_files"]
combined_unclassified = _dashboard_data["combined_unclassified"]
combined_asm_events = _dashboard_data["combined_asm_events"]
asm_source_files = _dashboard_data["asm_source_files"]
combined_crs_events = _dashboard_data["combined_crs_events"]
crs_source_files = _dashboard_data["crs_source_files"]
combined_listener_events = _dashboard_data["combined_listener_events"]
combined_listener_security = _dashboard_data["combined_listener_security"]
listener_source_files = _dashboard_data["listener_source_files"]
df_ora_all = _dashboard_data["df_ora_all"]
df_warn_all = _dashboard_data["df_warn_all"]
df_kill_all = _dashboard_data["df_kill_all"]
df_asm_all = _dashboard_data["df_asm_all"]
df_crs_all = _dashboard_data["df_crs_all"]
df_listener_all = _dashboard_data["df_listener_all"]
df_listener_security_all = _dashboard_data["df_listener_security_all"]
df_unclassified_all = _dashboard_data["df_unclassified_all"]
df_trace_all = _dashboard_data["df_trace_all"]
instance_info = _dashboard_data["instance_info"]

# ---------------- Quick Stats Dashboard ----------------
st.markdown("### 📊 Quick Statistics")

total_errors = len(combined_ora)
total_warnings = len(combined_warnings)
total_kills = len(combined_kill_sessions)
total_asm_events = len(combined_asm_events)
total_crs_events = len(combined_crs_events)
total_listener_events = len(combined_listener_events)
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

if crs_source_files:
    st.info(f"🧬 **CRS/Clusterware log(s) detected:** {', '.join(sorted(crs_source_files))} — CRS/Grid Infrastructure analysis is available below.")

    _evict_total = sum(1 for e in combined_crs_events if e.get("Event Type") == "Node Eviction / Fencing")
    if _evict_total > 0:
        st.error(f"🚨 **{_evict_total} node eviction/fencing event(s) found** — see '🧬 CRS/Clusterware Analysis → 🚨 Node Eviction & Fencing' below.")

    _ocr_total = sum(1 for e in combined_crs_events if e.get("Event Type") == "OCR/OLR Critical Failure")
    if _ocr_total > 0:
        st.error(f"🗄️ **{_ocr_total} OCR/OLR/voting-disk critical failure event(s) found** — see '🧬 CRS/Clusterware Analysis → 🗄️ OCR / OLR / Voting' below.")

    _agent_fail_total = sum(1 for e in combined_crs_events if e.get("Event Type") in {"Agent / Resource Failure", "Resource State Change"})
    if _agent_fail_total > 0:
        st.warning(f"⚙️ **{_agent_fail_total} agent/resource failure or state-change event(s) found** — see '🧬 CRS/Clusterware Analysis → ⚙️ Agent & Resource Failures' below.")

    _cvu_total = sum(1 for e in combined_crs_events if e.get("Event Type") == "Cluster Verification (CVU) Finding")
    if _cvu_total > 0:
        st.warning(f"🔍 **{_cvu_total} Cluster Verification Utility (CVU) finding(s)** — pre-req/config issue(s) flagged by CVU. See '🧬 CRS/Clusterware Analysis → 🔍 CVU Findings' below.")

if listener_source_files:
    st.info(f"📡 **Listener log(s) detected:** {', '.join(sorted(listener_source_files))} — Listener Log Analysis is available below.")

    _refused_total = sum(1 for e in combined_listener_events if e.get("Event Type") == "Connection Refused/Error")
    if _refused_total > 0:
        st.warning(f"🔌 **{_refused_total} refused/failed connection attempt(s) found** — see '📡 Listener Log Analysis → 🚫 Connection Errors' below.")

    _repeat_total = sum(1 for s in combined_listener_security if s.get("Alert Type") == "Repeated Connection Failures From Single Source")
    if _repeat_total > 0:
        st.error(f"🚨 **{_repeat_total} source(s) with repeated connection failures** — possible scanning/unauthorized access attempts. See '📡 Listener Log Analysis → 🛡️ Security Alerts' below immediately.")

    _svc_died_total = sum(1 for e in combined_listener_events if e.get("Event Type") == "Service Died")
    if _svc_died_total > 0:
        st.error(f"💀 **{_svc_died_total} 'service_died' event(s) found** — a registered instance/service dropped its listener registration. See '📡 Listener Log Analysis → 💀 Service Health' below.")

    _auth_fail_total = sum(1 for e in combined_listener_events if e.get("Event Type") == "Authentication Failure")
    if _auth_fail_total > 0:
        st.error(f"🔐 **{_auth_fail_total} listener authentication failure(s) (TNS-01189)** found — see '📡 Listener Log Analysis → 🛡️ Security Alerts' below immediately.")

    _acl_total = sum(1 for e in combined_listener_events if e.get("Event Type") == "Access Denied (ACL)")
    if _acl_total > 0:
        st.error(f"⛔ **{_acl_total} connection(s) rejected by Service ACL filtering (TNS-12506)** — a client was explicitly blocked by listener.ora's ACL rules. See '📡 Listener Log Analysis → 🛡️ Security Alerts' below immediately.")

    _admin_total = sum(1 for e in combined_listener_events if e.get("Event Type") in {"Listener Stop Command", "Listener Reload Command"})
    if _admin_total > 0:
        st.warning(f"🛠️ **{_admin_total} listener STOP/RELOAD admin command(s) found** — verify these were planned. See '📡 Listener Log Analysis → 🛠️ Admin Commands' below.")

    _other_cmd_total = sum(1 for e in combined_listener_events if e.get("Event Type") == "Other Command")
    if _other_cmd_total > 0:
        _other_cmd_names = sorted({e.get("Command") for e in combined_listener_events if e.get("Event Type") == "Other Command" and e.get("Command")})
        st.warning(f"🆕 **{_other_cmd_total} listener event(s) used a command this analyzer has no specific rule for yet** ({', '.join(_other_cmd_names[:8])}{'...' if len(_other_cmd_names) > 8 else ''}) — still fully captured with all fields, visible under '📡 Listener Log Analysis → 📋 All Listener Events'.")

    _unknown_tns_total = sum(
        1 for e in combined_listener_events
        if e.get("Error Code") and e["Error Code"].replace("TNS-", "").zfill(5) not in TNS_ERROR_INFO
    )
    if _unknown_tns_total > 0:
        _unknown_tns_codes = sorted({e["Error Code"] for e in combined_listener_events if e.get("Error Code") and e["Error Code"].replace("TNS-", "").zfill(5) not in TNS_ERROR_INFO})
        st.warning(f"🆕 **{_unknown_tns_total} error(s) with a TNS/NL/NZ code not in the built-in description dictionary** ({', '.join(_unknown_tns_codes[:8])}{'...' if len(_unknown_tns_codes) > 8 else ''}) — still captured with the raw error line, just without a friendly description. See '📡 Listener Log Analysis → 🚫 Connection Errors'.")

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
    if crs_source_files:
        st.metric("🧬 CRS Events", total_crs_events)
    if listener_source_files:
        st.metric("📡 Listener Events", total_listener_events)
else:
    # Desktop: Horizontal layout
    ncols = 6 + (1 if asm_source_files else 0) + (1 if crs_source_files else 0) + (1 if listener_source_files else 0)
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
    _next_col = 6
    if asm_source_files:
        with cols[_next_col]:
            st.metric("💽 ASM Events", total_asm_events)
        _next_col += 1
    if crs_source_files:
        with cols[_next_col]:
            st.metric("🧬 CRS Events", total_crs_events)
        _next_col += 1
    if listener_source_files:
        with cols[_next_col]:
            st.metric("📡 Listener Events", total_listener_events)
        _next_col += 1

st.markdown("---")

# ---------------- Global Filters ----------------
with st.expander("🔍 Filters & Search", expanded=False):
    tab1, tab2 = st.tabs(["📅 Date/Time Filter", "🔎 Keyword Search"])
    
    with tab1:
        today = date.today()
        # Bug fix: this used to look ONLY at df_ora_all for the default date
        # range. For a listener-only (or ASM/CRS-only) upload with zero ORA
        # errors, df_ora_all is empty, so the default silently fell back to
        # "today" — which then filtered EVERY row out of every table below
        # (Listener Events, Security Alerts, etc.) since the log's real
        # dates (e.g. Oct 2025) don't match today's date. Quick Stats still
        # showed correct counts (those are computed before filtering), so
        # only the tables below looked blank. Now the default range is
        # taken from whichever categories actually have data.
        _all_ts_frames = [df_ora_all, df_warn_all, df_kill_all, df_asm_all,
                           df_crs_all, df_listener_all, df_trace_all]
        _ts_parts = [f["ParsedTimestamp"].dropna() for f in _all_ts_frames
                     if not f.empty and "ParsedTimestamp" in f.columns and f["ParsedTimestamp"].notna().any()]
        if _ts_parts:
            _all_ts = pd.concat(_ts_parts)
            min_ts = _all_ts.min()
            max_ts = _all_ts.max()
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

def _search_mask(df, columns, q):
    """Vectorized replacement for the old per-row df.apply(axis=1) scan:
    case-insensitive substring match across several columns, OR'd together.
    Same semantics as before, but runs as fast native pandas string ops
    instead of a slow Python-level function call per row — this matters a
    lot since it used to re-run on every keystroke in the search box."""
    mask = pd.Series(False, index=df.index)
    for col in columns:
        if col in df.columns:
            mask = mask | df[col].astype(str).str.lower().str.contains(q, regex=False, na=False)
    return mask

if search_q:
    q = search_q.lower()
    df_ora_display = df_ora_all[_search_mask(df_ora_all, ["ORA Error", "Trace File", "Source"], q)].copy()
    df_warn_display = df_warn_all[_search_mask(df_warn_all, ["Warning Message", "Category", "Trace File", "Source"], q)].copy()
    df_kill_display = df_kill_all[_search_mask(df_kill_all, ["SID", "Serial#", "Reason", "Requestor", "Owner", "Source"], q)].copy()
    df_asm_display = df_asm_all[_search_mask(df_asm_all, ["Event Type", "Diskgroup", "Detail", "Source"], q)].copy()
    df_crs_display = df_crs_all[_search_mask(df_crs_all, ["Event Type", "CRS Code", "Component", "Node", "Detail", "Source"], q)].copy()
    df_listener_display = df_listener_all[_search_mask(df_listener_all, ["Event Type", "Command", "Service", "Client Host", "Client IP", "Program", "User", "Error Code", "Detail", "Source"], q)].copy()
    df_listener_security_display = df_listener_security_all[_search_mask(df_listener_security_all, ["Alert Type", "Source Host/IP", "Error Codes", "Detail", "Source"], q)].copy()
    df_unclassified_display = df_unclassified_all[_search_mask(df_unclassified_all, ["Match Type", "Matched", "Raw Line", "Source"], q)].copy()
    df_trace_display = df_trace_all[_search_mask(df_trace_all, ["Trace File", "Source"], q)].copy()
else:
    df_ora_display = df_ora_all.copy()
    df_warn_display = df_warn_all.copy()
    df_kill_display = df_kill_all.copy()
    df_asm_display = df_asm_all.copy()
    df_crs_display = df_crs_all.copy()
    df_listener_display = df_listener_all.copy()
    df_listener_security_display = df_listener_security_all.copy()
    df_unclassified_display = df_unclassified_all.copy()
    df_trace_display = df_trace_all.copy()

df_ora_display = apply_global_date_filter(df_ora_display, global_start_dt, global_end_dt)
df_warn_display = apply_global_date_filter(df_warn_display, global_start_dt, global_end_dt)
df_kill_display = apply_global_date_filter(df_kill_display, global_start_dt, global_end_dt)
df_asm_display = apply_global_date_filter(df_asm_display, global_start_dt, global_end_dt)
df_crs_display = apply_global_date_filter(df_crs_display, global_start_dt, global_end_dt)
df_listener_display = apply_global_date_filter(df_listener_display, global_start_dt, global_end_dt)
df_listener_security_display = apply_global_date_filter(df_listener_security_display, global_start_dt, global_end_dt)
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

    # Computed once inside the cached build_dashboard_data() pipeline above,
    # instead of re-scanning every line of every file on every rerun.
    info = instance_info

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

# ---------------- CRS / Clusterware (Grid Infrastructure) Analysis ----------------
if crs_source_files:
    expand_crs = st.session_state.get("voice_action") == "show_crs"
    with st.expander("🧬 CRS/Clusterware Analysis", expanded=expand_crs):
        st.markdown("""
        <div style='background: linear-gradient(135deg, #ff9966 0%, #ff5e62 100%);
                    padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
            <h4 style='margin: 0 0 0.5rem 0;'>🧬 CRS/Grid Infrastructure Events</h4>
            <p style='margin: 0; opacity: 0.9;'>Daemon startup/shutdown, node eviction & fencing, OCR/OLR/voting-disk health, agent & resource failures, network issues, and CVU findings</p>
        </div>
        """, unsafe_allow_html=True)

        if df_crs_display.empty:
            st.success("✅ No CRS/Clusterware events found in selected range/search")
        else:
            # ---- CRS Quick Metrics ----
            crs_type_counts = df_crs_display["Event Type"].value_counts()

            evict_count = crs_type_counts.get("Node Eviction / Fencing", 0)
            if evict_count > 0:
                st.error(f"🚨 **{evict_count} node eviction/fencing event(s) detected** — check the Node Eviction & Fencing tab below immediately.")

            ocr_count = crs_type_counts.get("OCR/OLR Critical Failure", 0)
            if ocr_count > 0:
                st.error(f"🗄️ **{ocr_count} OCR/OLR/voting-disk critical failure(s) detected** — check the OCR / OLR / Voting tab below immediately.")

            crs_m_cols = st.columns(3) if mobile_view else st.columns(4)

            def _crs_m(idx, label, val):
                with crs_m_cols[idx % len(crs_m_cols)]:
                    st.metric(label, int(val))

            _crs_m(0, "🚨 Evictions/Fencing", evict_count)
            _crs_m(1, "🗄️ OCR/OLR Failures", ocr_count)
            _crs_m(2, "🟢 Daemon Startups", crs_type_counts.get("Clusterware Startup", 0))
            _crs_m(3, "🔴 Daemon Shutdowns", crs_type_counts.get("Clusterware Shutdown", 0))

            crs_m_cols2 = st.columns(3) if mobile_view else st.columns(4)

            def _crs_m2(idx, label, val):
                with crs_m_cols2[idx % len(crs_m_cols2)]:
                    st.metric(label, int(val))

            _crs_m2(0, "⚙️ Agent/Resource Failures",
                    crs_type_counts.get("Agent / Resource Failure", 0) + crs_type_counts.get("Resource State Change", 0))
            _crs_m2(1, "🌐 Network/Interconnect", crs_type_counts.get("Network / Interconnect Issue", 0))
            _crs_m2(2, "🔍 CVU Findings", crs_type_counts.get("Cluster Verification (CVU) Finding", 0))
            _crs_m2(3, "🧩 Node Down/Membership",
                    crs_type_counts.get("Node Down / Membership", 0) + crs_type_counts.get("Server Pool Change", 0))

            generic_err = crs_type_counts.get("CRS Error", 0)
            generic_warn = crs_type_counts.get("CRS Warning", 0)
            if generic_err > 0 or generic_warn > 0:
                crs_m_cols3 = st.columns(2)
                with crs_m_cols3[0]:
                    st.metric("🔴 Other CRS Errors (unmapped)", int(generic_err))
                with crs_m_cols3[1]:
                    st.metric("🟡 Other CRS Warnings (unmapped)", int(generic_warn))

            crs_tab_labels = [
                "🚨 Node Eviction & Fencing", "🗄️ OCR / OLR / Voting", "🔄 Startup / Shutdown",
                "⚙️ Agent & Resource Failures", "🌐 Network / Interconnect",
                "🔍 CVU Findings", "🧩 Membership / Time Sync / ACFS", "📋 All CRS Events"
            ]
            crs_tabs = st.tabs(crs_tab_labels)

            def _show_crs_subset(event_types, empty_msg):
                sub = df_crs_display[df_crs_display["Event Type"].isin(event_types)]
                if sub.empty:
                    st.info(empty_msg)
                else:
                    st.dataframe(
                        sub.drop(columns=["ParsedTimestamp"], errors="ignore"),
                        use_container_width=True
                    )

            with crs_tabs[0]:
                _show_crs_subset(
                    ["Node Eviction / Fencing"],
                    "✅ No node eviction/fencing events found"
                )
            with crs_tabs[1]:
                _show_crs_subset(
                    ["OCR/OLR Critical Failure"],
                    "✅ No OCR/OLR/voting-disk failures found"
                )
            with crs_tabs[2]:
                _show_crs_subset(
                    ["Clusterware Startup", "Clusterware Shutdown"],
                    "✅ No daemon startup/shutdown events found"
                )
            with crs_tabs[3]:
                _show_crs_subset(
                    ["Agent / Resource Failure", "Resource State Change"],
                    "✅ No agent/resource failure events found"
                )
            with crs_tabs[4]:
                _show_crs_subset(
                    ["Network / Interconnect Issue"],
                    "✅ No network/interconnect issues found"
                )
            with crs_tabs[5]:
                st.caption(
                    "Cluster Verification Utility (CVU) findings — pre-requisite and configuration checks "
                    "(PRVG/PRVF/PRCT/... codes) that CRS-10051 surfaces. These are diagnostic/config issues, "
                    "not always active failures, but worth reviewing."
                )
                _show_crs_subset(
                    ["Cluster Verification (CVU) Finding"],
                    "✅ No CVU findings recorded"
                )
            with crs_tabs[6]:
                st.caption(
                    "Node membership/server-pool changes, Cluster Time Synchronization Service state, "
                    "and ACFS/AFD driver messages — useful correlation signals around cluster stability."
                )
                _show_crs_subset(
                    ["Node Down / Membership", "Server Pool Change", "Time Sync Service", "ACFS / AFD Driver"],
                    "✅ No membership/time-sync/ACFS events found"
                )
            with crs_tabs[7]:
                st.dataframe(
                    df_crs_display.drop(columns=["ParsedTimestamp"], errors="ignore"),
                    use_container_width=True
                )

                st.markdown("#### 📊 CRS Event Distribution")
                crs_dist = df_crs_display["Event Type"].value_counts().reset_index()
                crs_dist.columns = ["Event Type", "Count"]
                st.dataframe(crs_dist, use_container_width=True)

                if not df_crs_display.empty:
                    code_dist = df_crs_display[df_crs_display["CRS Code"] != "-"]["CRS Code"].value_counts().reset_index()
                    if not code_dist.empty:
                        code_dist.columns = ["CRS Code", "Event Count"]
                        st.markdown("#### 🔢 Events by CRS Code")
                        st.dataframe(code_dist.head(30), use_container_width=True)

                    node_dist = df_crs_display[df_crs_display["Node"] != "-"]["Node"].value_counts().reset_index()
                    if not node_dist.empty:
                        node_dist.columns = ["Node", "Event Count"]
                        st.markdown("#### 🖥️ Events by Node")
                        st.dataframe(node_dist, use_container_width=True)

# ---------------- Listener Log Analysis ----------------
if listener_source_files:
    expand_listener = st.session_state.get("voice_action") == "show_listener"
    with st.expander("📡 Listener Log Analysis", expanded=expand_listener):
        st.markdown("""
        <div style='background: linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%);
                    padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
            <h4 style='margin: 0 0 0.5rem 0;'>📡 TNS Listener Events</h4>
            <p style='margin: 0; opacity: 0.9;'>Connections, service registration/health, status polls, admin commands, TNS errors & security alerts</p>
        </div>
        """, unsafe_allow_html=True)

        if df_listener_display.empty:
            st.success("✅ No listener events found in selected range/search")
        else:
            # ---- Listener Quick Metrics ----
            lsnr_type_counts = df_listener_display["Event Type"].value_counts()

            repeat_fail_count = int((df_listener_security_display["Alert Type"] == "Repeated Connection Failures From Single Source").sum()) if not df_listener_security_display.empty else 0
            if repeat_fail_count > 0:
                st.error(f"🚨 **{repeat_fail_count} source(s) with repeated connection failures** — check the 🛡️ Security Alerts tab below immediately.")

            svc_died_count = lsnr_type_counts.get("Service Died", 0)
            if svc_died_count > 0:
                st.error(f"💀 **{svc_died_count} 'service_died' event(s)** — a service lost its listener registration. Check 💀 Service Health below.")

            auth_fail_count = lsnr_type_counts.get("Authentication Failure", 0)
            if auth_fail_count > 0:
                st.error(f"🔐 **{auth_fail_count} authentication failure(s) (TNS-01189)** — check 🛡️ Security Alerts below immediately.")

            lsnr_m_cols = st.columns(3) if mobile_view else st.columns(5)

            def _lsnr_m(idx, label, val):
                with lsnr_m_cols[idx % len(lsnr_m_cols)]:
                    st.metric(label, int(val))

            acl_denied_count = lsnr_type_counts.get("Access Denied (ACL)", 0)

            _lsnr_m(0, "✅ Established", lsnr_type_counts.get("Connection Established", 0))
            _lsnr_m(1, "🚫 Refused/Error", lsnr_type_counts.get("Connection Refused/Error", 0))
            _lsnr_m(2, "🔎 Unknown Service/SID", lsnr_type_counts.get("Unknown Service/SID Requested", 0))
            _lsnr_m(3, "🔐 Auth Failures", auth_fail_count)
            _lsnr_m(4, "⛔ ACL Denied", acl_denied_count)

            lsnr_m_cols2 = st.columns(3) if mobile_view else st.columns(4)

            def _lsnr_m2(idx, label, val):
                with lsnr_m_cols2[idx % len(lsnr_m_cols2)]:
                    st.metric(label, int(val))

            _lsnr_m2(0, "🔄 Service Updates", lsnr_type_counts.get("Service Update", 0))
            _lsnr_m2(1, "📝 Service Registered", lsnr_type_counts.get("Service Registered", 0))
            _lsnr_m2(2, "💀 Service Died", svc_died_count)
            _lsnr_m2(3, "📶 Status Checks", lsnr_type_counts.get("Status Check", 0))

            admin_count = lsnr_type_counts.get("Listener Stop Command", 0) + lsnr_type_counts.get("Listener Reload Command", 0) + lsnr_type_counts.get("Admin Command", 0)
            if admin_count > 0 or repeat_fail_count > 0:
                lsnr_m_cols3 = st.columns(2)
                with lsnr_m_cols3[0]:
                    st.metric("🛠️ Admin Commands (stop/reload/etc)", int(admin_count))
                with lsnr_m_cols3[1]:
                    st.metric("🛡️ Security Alerts", int(len(df_listener_security_display)))

            listener_tab_labels = [
                "🚫 Connection Errors", "✅ Established Connections", "💀 Service Health",
                "📶 Status / Registration", "🛠️ Admin Commands", "🛡️ Security Alerts",
                "🆕 Other / New Commands", "📋 All Listener Events"
            ]
            listener_tabs = st.tabs(listener_tab_labels)

            def _show_listener_subset(event_types, empty_msg, df_source=None):
                src = df_source if df_source is not None else df_listener_display
                sub = src[src["Event Type"].isin(event_types)]
                if sub.empty:
                    st.info(empty_msg)
                else:
                    st.dataframe(
                        sub.drop(columns=["ParsedTimestamp"], errors="ignore"),
                        use_container_width=True
                    )

            with listener_tabs[0]:
                st.caption(
                    "Every refused/failed connection attempt, with the TNS-nnnnn error code and description "
                    "attached. Includes 'unknown service/SID' probing, ACL/firewall-level rejections, and "
                    "malformed/unauthenticated connect attempts."
                )
                _show_listener_subset(
                    ["Connection Refused/Error", "Unknown Service/SID Requested", "Authentication Failure", "Access Denied (ACL)"],
                    "✅ No connection errors found"
                )
                if not df_listener_display.empty:
                    err_sub = df_listener_display[df_listener_display["Event Type"].isin(
                        ["Connection Refused/Error", "Unknown Service/SID Requested", "Authentication Failure", "Access Denied (ACL)"])]
                    if not err_sub.empty and "Error Code" in err_sub.columns:
                        code_dist = err_sub[err_sub["Error Code"].notna()]["Error Code"].value_counts().reset_index()
                        if not code_dist.empty:
                            code_dist.columns = ["Error Code", "Count"]
                            st.markdown("#### 🔢 Errors by TNS Code")
                            st.dataframe(code_dist, use_container_width=True)
                        ip_dist = err_sub[err_sub["Client IP"] != "-"]["Client IP"].value_counts().reset_index()
                        if not ip_dist.empty:
                            ip_dist.columns = ["Client IP", "Failed Attempts"]
                            st.markdown("#### 🌐 Errors by Source IP")
                            st.dataframe(ip_dist.head(30), use_container_width=True)

            with listener_tabs[1]:
                _show_listener_subset(["Connection Established"], "✅ No established connections in this range")
                if not df_listener_display.empty:
                    est_sub = df_listener_display[df_listener_display["Event Type"] == "Connection Established"]
                    if not est_sub.empty:
                        svc_dist = est_sub[est_sub["Service"] != "-"]["Service"].value_counts().reset_index()
                        if not svc_dist.empty:
                            svc_dist.columns = ["Service", "Connections"]
                            st.markdown("#### 🧩 Connections by Service")
                            st.dataframe(svc_dist, use_container_width=True)

            with listener_tabs[2]:
                st.caption(
                    "service_update (routine PMON heartbeat), service_register (new service handler registered), "
                    "and service_died (a service LOST its registration — worth investigating if unexpected)."
                )
                _show_listener_subset(
                    ["Service Update", "Service Registered", "Service Died"],
                    "✅ No service health events found"
                )

            with listener_tabs[3]:
                _show_listener_subset(
                    ["Status Check", "Listener Startup"],
                    "✅ No status-check/startup events found"
                )

            with listener_tabs[4]:
                st.caption(
                    "lsnrctl administrative/control commands — STOP and RELOAD get their own event types since "
                    "they change listener availability; verify these were planned maintenance."
                )
                _show_listener_subset(
                    ["Listener Stop Command", "Listener Reload Command", "Admin Command"],
                    "✅ No admin/control commands found"
                )

            with listener_tabs[5]:
                st.caption(
                    "Higher-signal alerts built on top of the raw events: repeated failures from one source "
                    "(possible scanning/unauthorized probing), authentication failures, unknown service/SID "
                    "requests, service_died events, and listener STOP/RELOAD commands."
                )
                if df_listener_security_display.empty:
                    st.success("✅ No security-relevant alerts found in selected range/search")
                else:
                    st.dataframe(
                        df_listener_security_display.drop(columns=["ParsedTimestamp"], errors="ignore")
                        .sort_values("Occurrences", ascending=False, kind="stable"),
                        use_container_width=True
                    )
                    alert_dist = df_listener_security_display["Alert Type"].value_counts().reset_index()
                    alert_dist.columns = ["Alert Type", "Count"]
                    st.markdown("#### 📊 Security Alerts by Type")
                    st.dataframe(alert_dist, use_container_width=True)

            with listener_tabs[6]:
                st.caption(
                    "Lines that matched the listener line shape but used a command word this analyzer has "
                    "no specific rule for yet (e.g. a new lsnrctl sub-command in a future Oracle version), "
                    "PLUS any TNS/NL/NZ error code not in the built-in description dictionary. Nothing here "
                    "is dropped — every field (timestamp, client host/IP, program, service, raw line) is "
                    "still fully captured; it just doesn't have a friendly category/description yet. Use "
                    "this tab to spot genuinely new patterns first."
                )
                other_cmd_sub = df_listener_display[df_listener_display["Event Type"] == "Other Command"]
                unknown_tns_sub = df_listener_display[
                    df_listener_display["Error Code"].notna()
                    & ~df_listener_display["Error Code"].apply(lambda c: str(c).replace("TNS-", "").zfill(5) in TNS_ERROR_INFO)
                ] if "Error Code" in df_listener_display.columns else df_listener_display.iloc[0:0]
                new_sub = pd.concat([other_cmd_sub, unknown_tns_sub]).drop_duplicates()
                if new_sub.empty:
                    st.success("✅ Nothing new — every event matched a known command and every error matched a known TNS/NL/NZ code")
                else:
                    st.dataframe(new_sub.drop(columns=["ParsedTimestamp"], errors="ignore"), use_container_width=True)
                    if not other_cmd_sub.empty:
                        st.markdown("#### 🆕 Unrecognized Commands")
                        _oc = other_cmd_sub["Command"].value_counts().reset_index()
                        _oc.columns = ["Command", "Count"]
                        st.dataframe(_oc, use_container_width=True)
                    if not unknown_tns_sub.empty:
                        st.markdown("#### 🆕 Unrecognized TNS/NL/NZ Codes")
                        _ut = unknown_tns_sub["Error Code"].value_counts().reset_index()
                        _ut.columns = ["Error Code", "Count"]
                        st.dataframe(_ut, use_container_width=True)

            with listener_tabs[7]:
                st.dataframe(
                    df_listener_display.drop(columns=["ParsedTimestamp"], errors="ignore"),
                    use_container_width=True
                )

                st.markdown("#### 📊 Listener Event Distribution")
                lsnr_dist = df_listener_display["Event Type"].value_counts().reset_index()
                lsnr_dist.columns = ["Event Type", "Count"]
                st.dataframe(lsnr_dist, use_container_width=True)

                prog_dist = df_listener_display[df_listener_display["Program"] != "-"]["Program"].value_counts().reset_index()
                if not prog_dist.empty:
                    prog_dist.columns = ["Client Program", "Event Count"]
                    st.markdown("#### 💻 Events by Client Program")
                    st.dataframe(prog_dist.head(30), use_container_width=True)

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
                # Reuse the ORA rows already parsed once in build_dashboard_data()
                # above instead of re-running the parser on these files again.
                ora_a = [e for e in combined_ora if e.get("Source") == file_a]
                ora_b = [e for e in combined_ora if e.get("Source") == file_b]
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
@st.cache_data(show_spinner=False, max_entries=4)
def _build_excel_report(df_ora, df_warn, df_kill, df_asm, df_crs, df_listener, df_listener_sec, df_unclassified, df_trace):
    """Builds the full multi-sheet Excel workbook. Cached on the content of
    the underlying DataFrames, so it's only rebuilt when the parsed data
    actually changes — not on every rerun caused by an unrelated widget
    (search box, date filter, tab click, etc.), which is what made opening
    this section (and just using the app in general) slow before."""
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="xlsxwriter") as writer:
        if not df_ora.empty:
            strip_tz_for_excel(df_ora).to_excel(writer, index=False, sheet_name="ORA_Errors")

        if not df_warn.empty:
            strip_tz_for_excel(df_warn).to_excel(writer, index=False, sheet_name="Warnings")

        if not df_kill.empty:
            strip_tz_for_excel(df_kill).to_excel(writer, index=False, sheet_name="Kill_Sessions")

        if not df_asm.empty:
            strip_tz_for_excel(df_asm).to_excel(writer, index=False, sheet_name="ASM_Events")

        if not df_crs.empty:
            strip_tz_for_excel(df_crs).to_excel(writer, index=False, sheet_name="CRS_Events")

        if not df_listener.empty:
            strip_tz_for_excel(df_listener).to_excel(writer, index=False, sheet_name="Listener_Events")

        if not df_listener_sec.empty:
            strip_tz_for_excel(df_listener_sec).to_excel(writer, index=False, sheet_name="Listener_Security_Alerts")

        if not df_unclassified.empty:
            strip_tz_for_excel(df_unclassified).to_excel(writer, index=False, sheet_name="Unclassified_New")

        if not df_trace.empty:
            strip_tz_for_excel(df_trace).to_excel(writer, index=False, sheet_name="Trace_Files")

    return buf.getvalue()


expand_download = st.session_state.get("voice_action") == "export"
with st.expander("💾 Download Parsed Results", expanded=expand_download):
    if (not combined_ora) and (not combined_warnings) and (not combined_kill_sessions) and (not combined_asm_events) and (not combined_crs_events) and (not combined_listener_events) and (not combined_trace_files):
        st.info("🔭 No parsed data to download")
    else:
        st.markdown("""
        <div style='background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); 
                    padding: 1.5rem; border-radius: 8px; color: white; margin-bottom: 1rem;'>
            <h4 style='margin: 0 0 0.5rem 0;'>📥 Export Your Analysis</h4>
            <p style='margin: 0; opacity: 0.9;'>Download complete parsed results in Excel format</p>
        </div>
        """, unsafe_allow_html=True)

        excel_bytes = _build_excel_report(
            df_ora_all, df_warn_all, df_kill_all, df_asm_all, df_crs_all,
            df_listener_all, df_listener_security_all, df_unclassified_all, df_trace_all,
        )

        filename = f"parsed_alert_log_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
        st.download_button(
            "📥 Download Excel Report", 
            data=excel_bytes, 
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
