# Alert.py – Oracle Alert Log Analyzer Pro (Enhanced UI with Mobile, Voice & Audio)
# Run: streamlit run Alert.py

import re
import os
import io
import time
import zipfile
import traceback
import pandas as pd
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
    initial_sidebar_state="expanded",
    menu_items={
        'About': "Oracle Alert Log Analyzer Pro - Advanced diagnostic tool for DBAs"
    }
)

# ---------------- Initialize Session State ----------------
if "audio_enabled" not in st.session_state:
    st.session_state.audio_enabled = False
if "voice_enabled" not in st.session_state:
    st.session_state.voice_enabled = False
if "voice_command" not in st.session_state:
    st.session_state.voice_command = ""
if "trigger_audio" not in st.session_state:
    st.session_state.trigger_audio = False
if "audio_severity" not in st.session_state:
    st.session_state.audio_severity = "medium"
if "voice_action" not in st.session_state:
    st.session_state.voice_action = None
if "last_voice_command" not in st.session_state:
    st.session_state.last_voice_command = ""

# ---------------- Audio Alerts Configuration ----------------
AUDIO_ALERTS_ENABLED = st.sidebar.checkbox("🔊 Enable Audio Alerts", value=st.session_state.audio_enabled, key="audio_alerts_toggle")
st.session_state.audio_enabled = AUDIO_ALERTS_ENABLED

AUDIO_SEVERITY_LEVELS = {
    "critical": {"frequency": 800, "duration": 500, "label": "🔴 Critical"},
    "high": {"frequency": 600, "duration": 300, "label": "🟠 High"},
    "medium": {"frequency": 400, "duration": 200, "label": "🟡 Medium"},
    "low": {"frequency": 300, "duration": 150, "label": "🟢 Low"}
}

# ---------------- Theme Switcher ----------------
theme_choice = st.sidebar.radio(
    "🎨 Theme Mode", ["Light Mode", "Dark Mode"], index=0, key="theme_toggle"
)


# ---------------- Mobile View Toggle ----------------
mobile_view = st.sidebar.checkbox("📱 Mobile View", value=False, key="mobile_view_toggle")

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


# ---------------- Audio Alert Functions ----------------
def play_audio_alert(severity="medium"):
    """Generate audio alert based on severity using HTML component"""
    if not AUDIO_ALERTS_ENABLED:
        return
    
    config = AUDIO_SEVERITY_LEVELS.get(severity, AUDIO_SEVERITY_LEVELS["medium"])
    
    audio_html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <script>
            function playAlert() {{
                try {{
                    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    const oscillator = audioContext.createOscillator();
                    const gainNode = audioContext.createGain();
                    
                    oscillator.connect(gainNode);
                    gainNode.connect(audioContext.destination);
                    
                    oscillator.frequency.value = {config['frequency']};
                    oscillator.type = 'sine';
                    
                    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
                    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + {config['duration']/1000});
                    
                    oscillator.start(audioContext.currentTime);
                    oscillator.stop(audioContext.currentTime + {config['duration']/1000});
                }} catch(e) {{
                    console.error('Audio error:', e);
                }}
            }}
            
            // Auto-play when loaded
            window.onload = playAlert;
        </script>
    </head>
    <body>
        <div style="display:none;">Audio Alert Playing...</div>
    </body>
    </html>
    """
    
    components.html(audio_html, height=0)

def speak_text(text):
    """Text-to-speech for critical alerts"""
    if not AUDIO_ALERTS_ENABLED:
        return
    
    speech_html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <script>
            function speakText() {{
                if ('speechSynthesis' in window) {{
                    const utterance = new SpeechSynthesisUtterance("{text}");
                    utterance.rate = 1.0;
                    utterance.pitch = 1.0;
                    utterance.volume = 0.8;
                    window.speechSynthesis.speak(utterance);
                }}
            }}
            
            window.onload = speakText;
        </script>
    </head>
    <body>
        <div style="display:none;">Speaking...</div>
    </body>
    </html>
    """
    
    components.html(speech_html, height=0)

# ---------------- Regex & Helpers ----------------
TIMESTAMP_RE = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+(?:[\+\-]\d{2}:\d{2}))")
ORA_RE = re.compile(r"\bORA-(\d{3,5}):?\s*(.*)")
WARN_RE = re.compile(r"\bWARNING\b|\bWarning\b|\bwarning\b")
TRACE_RE = re.compile(r"(\/[\w\/\.\-\+]*\.trc)")
KILL_SESSION_RE = re.compile(r"KILL SESSION for sid=\((\d+),\s*(\d+)\)", re.IGNORECASE)

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
    current_timestamp = None

    trace_locations = [(i, TRACE_RE.search(line).group(1)) for i, line in enumerate(lines) if TRACE_RE.search(line)]

    def find_nearby_trace(idx):
        for t_idx, t_path in trace_locations:
            if 0 <= t_idx - idx <= 5:
                return t_path
        return "Not Found"
    
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
                })
        elif WARN_RE.search(line):
            warnings.append({
                "Timestamp": current_timestamp or "Not Found",
                "Warning Message": line.strip(),
                "Trace File": find_nearby_trace(i),
                "Source": source_name,
                "Raw Line": line,
            })

    return ora_errors, warnings, kill_sessions

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
    shutdown_re = re.compile(r"(Shutting down|shutdown\s+complete|Shutdown\s+normal|shutdown complete)", re.I)
    crash_re = re.compile(
        r"(Instance terminated|terminated abnormally|abort|crash|ORA-00600|ORA-07445|core dump|ORA-609)",
        re.I
    )
    inst_re = re.compile(r"Instance\s+name[:\s]*([A-Za-z0-9_\-\.]+)", re.I)
    host_re = re.compile(r"Host\s*[:=]\s*([A-Za-z0-9\-\._]+)", re.I)

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
    <p style='color: #666; margin-bottom: 1rem;'>Select one or more Oracle alert log files to analyze</p>
</div>
""", unsafe_allow_html=True)

uploaded_files = st.file_uploader("", type=["log","txt","zip"], accept_multiple_files=True, label_visibility="collapsed")

if not uploaded_files:
    st.markdown("""
    <div style='background: white; padding: 3rem; border-radius: 12px; text-align: center; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);'>
        <h2 style='color: #667eea; margin-bottom: 1rem;'>👋 Welcome!</h2>
        <p style='font-size: 1.1rem; color: #666;'>Upload your Oracle alert log files above to begin analysis</p>
        <p style='color: #999; margin-top: 1rem;'>Supports .log and .txt files</p>
    </div>
    """, unsafe_allow_html=True)
    st.stop()

# Parse uploaded files
all_raw_lines = []
per_file_lines = {}
combined_ora = []
combined_warnings = []
combined_kill_sessions = []

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

                o, w, k = analyze_alert_log_lines(zlines, source_name=zname)
                combined_ora.extend(o)
                combined_warnings.extend(w)
                combined_kill_sessions.extend(k)
            continue

        # Normal .log / .txt files
        lines = lines_from_uploaded_file(f)
        per_file_lines[name] = lines
        all_raw_lines.append(f"--- BEGIN FILE: {name} ---")
        all_raw_lines.extend(lines)
        all_raw_lines.append(f"--- END FILE: {name} ---")

        o, w, k = analyze_alert_log_lines(lines, source_name=name)
        combined_ora.extend(o)
        combined_warnings.extend(w)
        combined_kill_sessions.extend(k)


df_ora_all = pd.DataFrame(combined_ora) if combined_ora else pd.DataFrame(columns=["Timestamp","ORA Error","Trace File","Source","Raw Line"])
df_warn_all = pd.DataFrame(combined_warnings) if combined_warnings else pd.DataFrame(columns=["Timestamp","Warning Message","Trace File","Source","Raw Line"])
df_kill_all = pd.DataFrame(combined_kill_sessions) if combined_kill_sessions else pd.DataFrame(columns=["Timestamp","SID","Serial#","Reason","Mode","Requestor","Owner","Result","Trace File","Source","Raw Line","Full Block"])

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

# ---------------- Quick Stats Dashboard ----------------
st.markdown("### 📊 Quick Statistics")

# Determine error severity and trigger audio alerts
total_errors = len(combined_ora)
total_warnings = len(combined_warnings)
total_kills = len(combined_kill_sessions)

if AUDIO_ALERTS_ENABLED and total_errors > 0:
    if total_errors > 100:
        play_audio_alert("critical")
        speak_text(f"Critical alert. {total_errors} errors detected")
    elif total_errors > 50:
        play_audio_alert("high")
        speak_text(f"High priority. {total_errors} errors found")
    elif total_errors > 10:
        play_audio_alert("medium")

if mobile_view:
    # Mobile: Stack metrics vertically
    st.metric("📄 Files Uploaded", len(uploaded_files))
    st.metric("🔴 ORA Errors", total_errors)
    st.metric("🟡 Warnings", total_warnings)
    st.metric("⚡ Kill Sessions", total_kills)
    unique_ora = len(df_ora_all["ORA Error"].unique()) if not df_ora_all.empty else 0
    st.metric("🔢 Unique ORA Codes", unique_ora)
else:
    # Desktop: Horizontal layout
    col1, col2, col3, col4, col5 = st.columns(5)
    with col1:
        st.metric("📄 Files Uploaded", len(uploaded_files))
    with col2:
        st.metric("🔴 ORA Errors", total_errors)
    with col3:
        st.metric("🟡 Warnings", total_warnings)
    with col4:
        st.metric("⚡ Kill Sessions", total_kills)
    with col5:
        unique_ora = len(df_ora_all["ORA Error"].unique()) if not df_ora_all.empty else 0
        st.metric("🔢 Unique ORA Codes", unique_ora)

# Audio alert severity indicator
if AUDIO_ALERTS_ENABLED:
    st.sidebar.markdown("### 📊 Alert Thresholds")
    st.sidebar.info(f"""
    **Current Status:**
    - Errors: {total_errors}
    - Warnings: {total_warnings}
    
    **Alert Levels:**
    - 🔴 Critical: >100 errors (with voice)
    - 🟠 High: >50 errors (with voice)
    - 🟡 Medium: >10 errors
    - 🟢 Low: <10 errors
    """)

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
else:
    df_ora_display = df_ora_all.copy()
    df_warn_display = df_warn_all.copy()
    df_kill_display = df_kill_all.copy()

df_ora_display = apply_global_date_filter(df_ora_display, global_start_dt, global_end_dt)
df_warn_display = apply_global_date_filter(df_warn_display, global_start_dt, global_end_dt)
df_kill_display = apply_global_date_filter(df_kill_display, global_start_dt, global_end_dt)

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



# ---------------- ORA Errors & Warnings Tabs ----------------
expand_errors_tab = st.session_state.get("voice_action") == "show_errors"
expand_warnings_tab = st.session_state.get("voice_action") == "show_warnings"

# If either tab should be expanded, show that one
if expand_errors_tab or expand_warnings_tab:
    tab_ora, tab_warn = st.tabs(["🔴 ORA Errors", "🟡 Warnings"])
    
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
                
                st.markdown("#### 📊 Top Warnings")
                top_w = df_warn_display["Warning Message"].value_counts().head(20).reset_index()
                top_w.columns = ["Warning Message", "Count"]
                st.dataframe(top_w, use_container_width=True)
            else:
                st.info("✅ No warnings found in selected range/search")
else:
    # Normal tabs without forced expansion
    tab_ora, tab_warn = st.tabs(["🔴 ORA Errors", "🟡 Warnings"])
    
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
                
                st.markdown("#### 📊 Top Warnings")
                top_w = df_warn_display["Warning Message"].value_counts().head(20).reset_index()
                top_w.columns = ["Warning Message", "Count"]
                st.dataframe(top_w, use_container_width=True)
            else:
                st.info("✅ No warnings found in selected range/search")

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
                view_mode = st.radio("Granularity", ["Hourly", "Daily"], key="chart_view")

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
                    df_chart_base["TimeBucket"] = df_chart_base["ParsedTimestamp"].dt.floor("H")
                    df_chart_base["MinuteStr"] = df_chart_base["ParsedTimestamp"].dt.strftime("%Y-%m-%d %H:%M")
                else:
                    df_chart_base["TimeBucket"] = df_chart_base["ParsedTimestamp"].dt.floor("D")
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
                x_vals = sorted(freq["TimeBucket"].unique())
                ora_codes = sorted(freq["ORA Error"].unique())

                fig = go.Figure()
                colors = [
                    '#667eea', '#764ba2', '#f093fb', '#f5576c',
                    '#4facfe', '#00f2fe', '#43e97b', '#38f9d7'
                ]

                for idx, ora in enumerate(ora_codes):
                    sub = freq[freq["ORA Error"] == ora].set_index("TimeBucket").reindex(
                        x_vals, fill_value=0
                    ).reset_index()

                    sample_map = dict(zip(sub["TimeBucket"], sub["SampleMinutes"]))

                    hover_text = [
                        f"<b>Time:</b> {x}<br>"
                        f"<b>ORA:</b> {ora}<br>"
                        f"<b>Count:</b> {int(cnt)}<br>"
                        f"<b>Sample:</b> {sample_map.get(x, '')}"
                        for x, cnt in zip(sub["TimeBucket"], sub["Count"])
                    ]

                    fig.add_trace(go.Bar(
                        x=sub["TimeBucket"],
                        y=sub["Count"],
                        name=ora,
                        text=sub["Count"],
                        textposition="outside",
                        hovertext=hover_text,
                        hoverinfo="text",
                        marker_color=colors[idx % len(colors)]
                    ))

                x_label = "Hour" if view_mode == "Hourly" else "Date"

                fig.update_layout(
                    barmode="group",
                    bargap=0.30,
                    bargroupgap=0.05,
                    title=f"ORA Error Frequency ({view_mode}) – {selected_log}",
                    xaxis=dict(
                        title=x_label,
                        tickangle=0,
                        type="category",
                        tickfont=dict(size=11),
                        showgrid=True,
                        gridcolor='rgba(0,0,0,0.05)',
                    ),
                    yaxis=dict(
                        title="Occurrences (Log Scale)",
                        type="log",
                        dtick=1,
                        showgrid=True,
                        gridcolor='rgba(0,0,0,0.15)',
                    ),
                    legend_title_text="ORA Error",
                    height=600,
                    margin=dict(l=30, r=30, t=60, b=120),
                    plot_bgcolor="white",
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
                ora_a, warn_a, kill_a = analyze_alert_log_lines(per_file_lines[file_a], source_name=file_a)
                ora_b, warn_b, kill_b = analyze_alert_log_lines(per_file_lines[file_b], source_name=file_b)
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
    if (not combined_ora) and (not combined_warnings) and (not combined_kill_sessions):
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