"""
🎯 Oracle Database Management Dashboard - Perfect Edition v8.0 WITH SIDEBAR FIX
Revolutionary enterprise-grade DBA toolkit with pixel-perfect UI/UX
Run: streamlit run oracle_unified_dashboard.py
"""

import streamlit as st
import sys
import os
from pathlib import Path
import re
from datetime import datetime
import importlib.util

# ==================== PAGE CONFIGURATION ====================
st.set_page_config(
    page_title="Oracle Database Management",
    layout="wide",
    initial_sidebar_state="collapsed",
    page_icon="🎯"
)

# ==================== SESSION STATE INITIALIZATION ====================
if 'current_module' not in st.session_state:
    st.session_state.current_module = 'home'
if 'show_module_content' not in st.session_state:
    st.session_state.show_module_content = False
if 'previous_module' not in st.session_state:
    st.session_state.previous_module = 'home'
if 'stats' not in st.session_state:
    st.session_state.stats = {
        'health_checks': 0,
        'logs_analyzed': 0,
        'awr_reports': 0
    }
if 'module_loaded' not in st.session_state:
    st.session_state.module_loaded = False

# Detect module change and clear widget states
if st.session_state.get('current_module') != st.session_state.get('previous_module'):
    st.session_state.previous_module = st.session_state.current_module
    st.session_state.module_loaded = False  # Reset on module change
    # Clear any cached widget states when switching modules
    for key in list(st.session_state.keys()):
        if key.startswith('FormSubmitter:') or key.startswith('back_btn'):
            del st.session_state[key]

# ==================== MODULE DETECTION ====================
REQUIRED_FILES = {
    'health_check': ['Checkup.py', 'oracle_functions.py', 'oracle_ui.py', 'analysis_utils.py'],
    'alert_log': ['Alert.py'],
    'awr': ['app.py']
}

MODULES_STATUS = {}
for module_key, files in REQUIRED_FILES.items():
    missing = [f for f in files if not Path(f).exists()]
    MODULES_STATUS[module_key] = {
        'available': len(missing) == 0,
        'missing': missing,
        'icon': '✅' if len(missing) == 0 else '❌',
        'title': {
            'health_check': 'Health Check Analyzer',
            'alert_log': 'Alert Log Analyzer',
            'awr': 'AWR Analyzer'
        }[module_key],
        'description': {
            'health_check': 'Comprehensive database health assessment with Oracle integration',
            'alert_log': 'Advanced alert log parsing and error analysis',
            'awr': 'AWR report analysis with performance insights'
        }[module_key]
    }

# ==================== PERFECT STYLING ====================
def apply_perfect_styles():
    """Apply pixel-perfect styling with full-screen hero and proper formatting"""
    st.markdown("""
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800;900&display=swap');
    
    /* ==================== GLOBAL RESET ==================== */
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    
    /* ==================== ANIMATED GRADIENT BACKGROUND ==================== */
    html, body, [data-testid="stAppViewContainer"] {
        font-family: 'Poppins', -apple-system, BlinkMacSystemFont, sans-serif;
        background: linear-gradient(-45deg, #667eea, #764ba2, #f093fb, #4facfe);
        background-size: 400% 400%;
        animation: gradientShift 15s ease infinite;
        min-height: 100vh;
    }
    
    @keyframes gradientShift {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
    }
    
    /* Hide Streamlit Elements */
    #MainMenu {visibility: hidden;}
    footer {visibility: hidden;}
    header {visibility: hidden;}
    
    /* ==================== CRITICAL SIDEBAR TOGGLE FIX ==================== */
    /* These rules ensure the toggle button is ALWAYS visible and functional */
    
    /* Collapsed sidebar toggle button - FORCE VISIBILITY */
    [data-testid="collapsedControl"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        position: fixed !important;
        top: 0.5rem !important;
        left: 0.5rem !important;
        z-index: 2147483647 !important;
    }
    
    /* The actual button inside the collapsed control */
    [data-testid="collapsedControl"] button {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        background: rgba(255, 255, 255, 0.95) !important;
        border-radius: 8px !important;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15) !important;
        transition: all 0.3s ease !important;
    }
    
    [data-testid="collapsedControl"] button:hover {
        background: rgba(255, 255, 255, 1) !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2) !important;
        transform: scale(1.05) !important;
    }
    
    /* Expanded sidebar toggle button */
    [data-testid="stSidebarCollapsedControl"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
    }
    
    /* Base sidebar styling */
    [data-testid="stSidebar"] {
        z-index: 999998 !important;
    }
    
    /* Ensure sidebar content doesn't overlap toggle */
    [data-testid="stSidebar"] > div:first-child {
        padding-top: 4rem !important;
    }
    
    /* ==================== MAIN CONTAINER - NO PADDING ==================== */
    .main {
        padding: 0 !important;
        max-width: 100% !important;
        overflow-x: visible !important;
    }
    
    .block-container {
        padding: 0 !important;
        max-width: 100% !important;
        margin: 0 !important;
        overflow-x: visible !important;
    }
    
    /* ==================== FULL SCREEN HERO SECTION ==================== */
    .hero-fullscreen {
        position: relative;
        height: 55vh;
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        background: linear-gradient(135deg, rgba(102, 126, 234, 0.95) 0%, rgba(118, 75, 162, 0.95) 100%);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        overflow: hidden;
        padding: 4rem 2rem;
        animation: heroEntrance 1.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    @keyframes heroEntrance {
        0% {
            opacity: 0;
            transform: scale(0.95);
        }
        100% {
            opacity: 1;
            transform: scale(1);
        }
    }
    
    /* Animated Background Particles */
    .hero-fullscreen::before {
        content: '';
        position: absolute;
        top: -50%;
        left: -50%;
        width: 200%;
        height: 200%;
        background: 
            radial-gradient(circle at 20% 50%, rgba(255, 255, 255, 0.15) 0%, transparent 50%),
            radial-gradient(circle at 80% 80%, rgba(255, 255, 255, 0.1) 0%, transparent 50%);
        animation: particleFloat 20s ease-in-out infinite;
    }
    
    @keyframes particleFloat {
        0%, 100% { 
            transform: translate(0, 0) rotate(0deg); 
        }
        33% { 
            transform: translate(30px, -30px) rotate(120deg); 
        }
        66% { 
            transform: translate(-20px, 20px) rotate(240deg); 
        }
    }
    
    .hero-fullscreen::after {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: 
            linear-gradient(45deg, transparent 30%, rgba(255, 255, 255, 0.08) 50%, transparent 70%);
        background-size: 200% 200%;
        animation: shimmer 4s linear infinite;
    }
    
    @keyframes shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
    }
    
    .hero-content-center {
        position: relative;
        z-index: 2;
        text-align: center;
        max-width: 1200px;
        margin: 0 auto;
    }
    
    /* Hero Icon with Perfect Animation */
    .hero-icon-large {
        font-size: 6rem;
        margin-bottom: 2rem;
        display: inline-block;
        filter: drop-shadow(0 15px 40px rgba(0, 0, 0, 0.4));
        animation: iconFloat 4s ease-in-out infinite;
    }
    
    @keyframes iconFloat {
        0%, 100% { 
            transform: translateY(0px) scale(1);
        }
        50% { 
            transform: translateY(-30px) scale(1.08);
        }
    }
    
    .hero-title-large {
        font-size: 4rem;
        font-weight: 900;
        color: #ffffff;
        margin: 0 0 1.5rem 0;
        text-shadow: 
            0 0 30px rgba(255, 255, 255, 0.5),
            0 0 60px rgba(255, 255, 255, 0.3),
            0 6px 30px rgba(0, 0, 0, 0.5);
        letter-spacing: -2px;
        animation: titleGlow 3s ease-in-out infinite;
        line-height: 1.1;
    }
    
    @keyframes titleGlow {
        0%, 100% { 
            text-shadow: 
                0 0 30px rgba(255, 255, 255, 0.5),
                0 0 60px rgba(255, 255, 255, 0.3);
        }
        50% { 
            text-shadow: 
                0 0 40px rgba(255, 255, 255, 0.8),
                0 0 80px rgba(255, 255, 255, 0.5);
        }
    }
    
    .hero-subtitle-large {
        font-size: 1.4rem;
        color: rgba(255, 255, 255, 0.95);
        margin: 0;
        font-weight: 400;
        letter-spacing: 0.5px;
        line-height: 1.6;
        text-shadow: 
            0 0 30px rgba(255, 255, 255, 0.5),
            0 0 60px rgba(255, 255, 255, 0.3);
        animation: subtitleGlow 3s ease-in-out infinite;
    }
    
    @keyframes subtitleGlow {
        0%, 100% { 
            text-shadow: 
                0 0 30px rgba(255, 255, 255, 0.5),
                0 0 60px rgba(255, 255, 255, 0.3);
        }
        50% { 
            text-shadow: 
                0 0 40px rgba(255, 255, 255, 0.8),
                0 0 80px rgba(255, 255, 255, 0.5);
        }
    }
    
    .scroll-indicator {
        position: absolute;
        bottom: 3rem;
        left: 50%;
        transform: translateX(-50%);
        animation: bounce 2s ease-in-out infinite;
        color: rgba(255, 255, 255, 0.8);
        font-size: 2.5rem;
        cursor: pointer;
        z-index: 10;
    }
    
    @keyframes bounce {
        0%, 100% { transform: translateX(-50%) translateY(0); }
        50% { transform: translateX(-50%) translateY(15px); }
    }
    
    /* ==================== CONTENT SECTION ==================== */
    .content-section {
        background: transparent;
        padding: 3rem 3rem 2rem 3rem;
        max-width: 1600px;
        margin: 0 auto;
    }
    
    /* ==================== WELCOME SECTION ==================== */
    .welcome-container {
        display: grid;
        grid-template-columns: 1fr;
        gap: 3rem;
        margin-bottom: 3rem;
    }
    
    .welcome-box {
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border-radius: 25px;
        padding: 3rem;
        border: 2px solid rgba(255, 255, 255, 0.3);
        box-shadow: 
            0 20px 50px rgba(0, 0, 0, 0.25),
            inset 0 0 30px rgba(255, 255, 255, 0.1);
        animation: slideInLeft 0.8s ease-out;
    }
    
    @keyframes slideInLeft {
        from {
            opacity: 0;
            transform: translateX(-50px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }
    
    .welcome-box h2 {
        font-size: 3.2rem !important;
        font-weight: 700 !important;
        color: #1f2937 !important;
        margin: 0 0 1.5rem 0 !important;
        padding: 0 !important;
        text-shadow: 
            0 0 20px rgba(102, 126, 234, 0.3),
            0 0 40px rgba(102, 126, 234, 0.15);
        animation: welcomeHeadingGlow 3s ease-in-out infinite;
    }
    
    @keyframes welcomeHeadingGlow {
        0%, 100% { 
            text-shadow: 
                0 0 20px rgba(102, 126, 234, 0.3),
                0 0 40px rgba(102, 126, 234, 0.15);
        }
        50% { 
            text-shadow: 
                0 0 30px rgba(102, 126, 234, 0.5),
                0 0 60px rgba(102, 126, 234, 0.25);
        }
    }
    
    .welcome-box h2::before {
        display: none !important;
    }
    
    .welcome-text {
        font-size: 1.7rem;
        line-height: 1.8;
        color: #4b5563;
        margin: 0;
        text-shadow: 
            0 0 15px rgba(102, 126, 234, 0.2),
            0 0 30px rgba(102, 126, 234, 0.1);
        animation: welcomeTextGlow 3s ease-in-out infinite;
    }
    
    @keyframes welcomeTextGlow {
        0%, 100% { 
            text-shadow: 
                0 0 15px rgba(102, 126, 234, 0.2),
                0 0 30px rgba(102, 126, 234, 0.1);
        }
        50% { 
            text-shadow: 
                0 0 20px rgba(102, 126, 234, 0.3),
                0 0 40px rgba(102, 126, 234, 0.15);
        }
    }
    
    .quick-start-box {
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border-radius: 25px;
        padding: 2.5rem;
        border: 2px solid rgba(255, 255, 255, 0.3);
        box-shadow: 
            0 20px 50px rgba(0, 0, 0, 0.25),
            inset 0 0 30px rgba(255, 255, 255, 0.1);
        animation: slideInRight 0.8s ease-out;
    }
    
    @keyframes slideInRight {
        from {
            opacity: 0;
            transform: translateX(50px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }
    
    .quick-start-box h3 {
        font-size: 2.3rem;
        font-weight: 700;
        color: #1f2937;
        margin: 0 0 1.5rem 0;
        display: flex;
        align-items: center;
        gap: 0.7rem;
    }
    
    .quick-start-list {
        list-style: none;
        padding: 0;
        margin: 0;
    }
    
    .quick-start-list li {
        font-size: 1.8rem;
        color: #4b5563;
        padding: 1rem 0;
        border-bottom: 1px solid rgba(0, 0, 0, 0.05);
        line-height: 1.6;
    }
    
    .quick-start-list li:last-child {
        border-bottom: none;
    }
    
    .quick-start-list li strong {
        color: #667eea;
        font-weight: 700;
        margin-right: 0.5rem;
        font-size: 1.9rem;
    }
    
    /* ==================== SECTION HEADERS ==================== */
    .section-header {
        font-size: 2rem;
        font-weight: 800;
        color: #ffffff;
        margin: 3rem 0 2rem 0;
        display: flex;
        align-items: center;
        gap: 1rem;
        text-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        animation: headerSlide 0.6s ease-out;
        padding-left: 1.5rem;
        position: relative;
    }
    
    .section-header::before {
        content: '';
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 6px;
        height: 80%;
        background: linear-gradient(180deg, #fff, rgba(255, 255, 255, 0.5));
        border-radius: 10px;
        box-shadow: 0 0 20px rgba(255, 255, 255, 0.5);
        animation: pulseBar 2s ease-in-out infinite;
    }
    
    @keyframes pulseBar {
        0%, 100% { 
            opacity: 0.6;
            box-shadow: 0 0 20px rgba(255, 255, 255, 0.5);
        }
        50% { 
            opacity: 1;
            box-shadow: 0 0 30px rgba(255, 255, 255, 0.8);
        }
    }
    
    @keyframes headerSlide {
        from {
            opacity: 0;
            transform: translateX(-50px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }
    
    /* ==================== MODULE CARDS - PERFECT LAYOUT ==================== */
    .modules-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 2.5rem;
        margin-bottom: 3rem;
    }
    
    .module-card {
        position: relative;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(20px);
        border-radius: 25px;
        padding: 3rem 2.5rem;
        overflow: hidden;
        border: 2px solid rgba(255, 255, 255, 0.3);
        box-shadow: 
            0 20px 50px rgba(0, 0, 0, 0.25),
            inset 0 0 30px rgba(255, 255, 255, 0.1);
        transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        animation: cardEntrance 0.6s cubic-bezier(0.4, 0, 0.2, 1) both;
        display: flex;
        flex-direction: column;
        min-height: 420px;
    }
    
    @keyframes cardEntrance {
        from {
            opacity: 0;
            transform: translateY(50px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
    
    .module-card:nth-child(1) { animation-delay: 0.1s; }
    .module-card:nth-child(2) { animation-delay: 0.2s; }
    .module-card:nth-child(3) { animation-delay: 0.3s; }
    
    /* Gradient Border Animation */
    .module-card::before {
        content: '';
        position: absolute;
        top: -2px;
        left: -2px;
        right: -2px;
        bottom: -2px;
        background: linear-gradient(45deg, #667eea, #764ba2, #f093fb, #4facfe, #667eea);
        background-size: 300% 300%;
        border-radius: 25px;
        z-index: -1;
        opacity: 0;
        transition: opacity 0.5s ease;
        animation: borderGlow 3s ease infinite;
    }
    
    @keyframes borderGlow {
        0%, 100% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
    }
    
    .module-card:hover::before {
        opacity: 1;
    }
    
    .module-card:hover {
        transform: translateY(-15px) scale(1.03);
        box-shadow: 
            0 30px 60px rgba(0, 0, 0, 0.3),
            0 0 50px rgba(102, 126, 234, 0.4),
            inset 0 0 40px rgba(255, 255, 255, 0.2);
    }
    
    .module-card.disabled {
        opacity: 0.6;
        background: rgba(200, 200, 200, 0.4);
        cursor: not-allowed;
    }
    
    .module-card.disabled:hover {
        transform: none;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    }
    
    .module-card.disabled::before {
        display: none;
    }
    
    /* Module Icon */
    .module-icon {
        font-size: 3.5rem;
        display: inline-block;
        margin-bottom: 1.5rem;
        filter: drop-shadow(0 8px 20px rgba(0, 0, 0, 0.2));
        animation: iconBounce 2s ease-in-out infinite;
        transition: all 0.3s ease;
    }
    
    @keyframes iconBounce {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-12px); }
    }
    
    .module-card:hover .module-icon {
        animation: iconSpin 0.6s ease-in-out;
        transform: scale(1.15);
    }
    
    @keyframes iconSpin {
        0% { transform: rotate(0deg) scale(1); }
        50% { transform: rotate(180deg) scale(1.25); }
        100% { transform: rotate(360deg) scale(1.15); }
    }
    
    /* Module Content */
    .module-card h3 {
        font-size: 1.4rem;
        font-weight: 700;
        color: #1f2937;
        margin: 0 0 1rem 0;
        transition: all 0.3s ease;
    }
    
    .module-card:hover h3 {
        color: #667eea;
    }
    
    .module-card p {
        font-size: 1rem;
        color: #6b7280;
        line-height: 1.7;
        margin: 0 0 auto 0;
        flex-grow: 1;
    }
    
    /* Status Badge */
    .module-status {
        display: inline-block;
        padding: 0.7rem 1.8rem;
        border-radius: 50px;
        font-weight: 700;
        font-size: 1.3rem;
        margin-top: 1.5rem;
        position: relative;
        overflow: hidden;
        animation: badgePulse 2s ease-in-out infinite;
    }
    
    @keyframes badgePulse {
        0%, 100% { 
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.7);
        }
        50% { 
            transform: scale(1.05);
            box-shadow: 0 0 20px 10px rgba(102, 126, 234, 0);
        }
    }
    
    .status-available {
        background: linear-gradient(135deg, #10b981 0%, #059669 100%);
        color: white;
        box-shadow: 0 5px 20px rgba(16, 185, 129, 0.4);
    }
    
    .status-unavailable {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        color: white;
        box-shadow: 0 5px 20px rgba(239, 68, 68, 0.4);
    }
    
    /* ==================== BUTTONS ==================== */
    .stButton > button {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        border-radius: 15px;
        padding: 1.2rem 2.5rem;
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: 0.5px;
        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 
            0 10px 30px rgba(102, 126, 234, 0.4),
            0 0 20px rgba(102, 126, 234, 0.2);
        position: relative;
        overflow: hidden;
        text-transform: uppercase;
        width: 100%;
        margin-top: 1rem;
    }
    
    .stButton > button::before {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 0;
        height: 0;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.4);
        transform: translate(-50%, -50%);
        transition: width 0.6s, height 0.6s;
    }
    
    .stButton > button:hover::before {
        width: 400px;
        height: 400px;
    }
    
    .stButton > button:hover {
        transform: translateY(-3px) scale(1.02);
        box-shadow: 
            0 20px 40px rgba(102, 126, 234, 0.5),
            0 0 40px rgba(102, 126, 234, 0.4);
    }
    
    .stButton > button:active {
        transform: translateY(-1px) scale(1);
    }
    
    /* ==================== STATS CARDS ==================== */
    .stats-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 2rem;
        margin-bottom: 3rem;
    }
    
    .stat-card {
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(20px);
        border-radius: 20px;
        padding: 2.5rem;
        text-align: center;
        position: relative;
        overflow: hidden;
        border: 2px solid rgba(255, 255, 255, 0.3);
        box-shadow: 
            0 20px 50px rgba(0, 0, 0, 0.25),
            inset 0 0 30px rgba(255, 255, 255, 0.1);
        transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        animation: statEntrance 0.8s ease-out both;
    }
    
    @keyframes statEntrance {
        from {
            opacity: 0;
            transform: scale(0.8) translateY(30px);
        }
        to {
            opacity: 1;
            transform: scale(1) translateY(0);
        }
    }
    
    .stat-card:nth-child(1) { animation-delay: 0.1s; }
    .stat-card:nth-child(2) { animation-delay: 0.2s; }
    .stat-card:nth-child(3) { animation-delay: 0.3s; }
    .stat-card:nth-child(4) { animation-delay: 0.4s; }
    
    .stat-card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 4px;
        background: linear-gradient(90deg, #667eea, #764ba2, #f093fb, #4facfe);
        background-size: 300% 100%;
        animation: gradientMove 3s ease infinite;
    }
    
    @keyframes gradientMove {
        0%, 100% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
    }
    
    .stat-card:hover {
        transform: translateY(-10px) scale(1.05);
        box-shadow: 
            0 30px 60px rgba(0, 0, 0, 0.3),
            0 0 50px rgba(102, 126, 234, 0.5),
            inset 0 0 40px rgba(255, 255, 255, 0.2);
    }
    
    .stat-number {
        font-size: 2.5rem;
        font-weight: 900;
        background: linear-gradient(135deg, #667eea, #764ba2, #f093fb);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
        margin-bottom: 0.5rem;
        animation: numberCount 1.5s ease-out;
    }
    
    @keyframes numberCount {
        from {
            opacity: 0;
            transform: scale(0.5);
        }
        to {
            opacity: 1;
            transform: scale(1);
        }
    }
    
    .stat-label {
        font-size: 1rem;
        color: #6b7280;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
    }
    
    /* ==================== FOOTER ==================== */
    .footer {
        text-align: center;
        padding: 3rem 2rem;
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(20px);
        border-radius: 25px;
        margin: 3rem 0 2rem 0;
        color: rgba(255, 255, 255, 0.95);
        border: 2px solid rgba(255, 255, 255, 0.2);
        box-shadow: 
            0 20px 50px rgba(0, 0, 0, 0.25),
            inset 0 0 30px rgba(255, 255, 255, 0.1);
        animation: fadeIn 1s ease-out;
    }
    
    @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
    }
    
    .footer p {
        margin: 0.8rem 0;
        font-size: 1.15rem;
    }
    
    .footer strong {
        font-weight: 700;
        color: #ffffff;
        text-shadow: 0 0 20px rgba(255, 255, 255, 0.5);
    }
    
    /* ==================== CUSTOM SCROLLBAR ==================== */
    ::-webkit-scrollbar {
        width: 12px;
    }
    
    ::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 10px;
    }
    
    ::-webkit-scrollbar-thumb {
        background: linear-gradient(180deg, #667eea, #764ba2);
        border-radius: 10px;
        box-shadow: 0 0 10px rgba(102, 126, 234, 0.5);
    }
    
    ::-webkit-scrollbar-thumb:hover {
        background: linear-gradient(180deg, #764ba2, #f093fb);
    }
    
    /* ==================== RESPONSIVE DESIGN ==================== */
    @media (max-width: 1200px) {
        .modules-grid {
            grid-template-columns: repeat(2, 1fr);
        }
        .stats-grid {
            grid-template-columns: repeat(2, 1fr);
        }
    }
    
    @media (max-width: 768px) {
        .hero-title-large { font-size: 3rem; }
        .hero-subtitle-large { font-size: 1.3rem; }
        .hero-icon-large { font-size: 5rem; }
        .modules-grid {
            grid-template-columns: 1fr;
        }
        .stats-grid {
            grid-template-columns: 1fr;
        }
        .welcome-container {
            grid-template-columns: 1fr;
        }
        .content-section {
            padding: 2rem 1.5rem;
        }
    }
    
    /* ==================== SMOOTH ANIMATIONS ==================== */
    html {
        scroll-behavior: smooth;
    }
    </style>
    """, unsafe_allow_html=True)

# ==================== SESSION STATE ====================
if 'current_module' not in st.session_state:
    st.session_state.current_module = 'home'
if 'show_module_content' not in st.session_state:
    st.session_state.show_module_content = False
if 'stats' not in st.session_state:
    st.session_state.stats = {
        'health_checks': 0,
        'logs_analyzed': 0,
        'awr_reports': 0
    }

# ==================== MODULE DISCOVERY ====================
CURRENT_DIR = Path(__file__).parent
REQUIRED_MODULES = {
    'health_check': 'Checkup.py',
    'alert_log': 'Alert.py',
    'awr': 'app.py'
}

MODULES_STATUS = {}

for module_key, filename in REQUIRED_MODULES.items():
    filepath = CURRENT_DIR / filename
    exists = filepath.exists()
    
    if module_key == 'health_check':
        MODULES_STATUS[module_key] = {
            'icon': '📱',
            'title': 'Health Check Module',
            'description': 'Comprehensive database health analysis with detailed metrics and recommendations for optimal performance',
            'available': exists,
            'missing': [] if exists else [filename]
        }
    elif module_key == 'alert_log':
        MODULES_STATUS[module_key] = {
            'icon': '📋',
            'title': 'Alert Log Analyzer',
            'description': 'Parse and analyze Oracle alert logs to identify critical issues, patterns, and anomalies',
            'available': exists,
            'missing': [] if exists else [filename]
        }
    elif module_key == 'awr':
        MODULES_STATUS[module_key] = {
            'icon': '📊',
            'title': 'AWR Analyzer',
            'description': 'Deep dive into AWR reports with performance insights and expert tuning recommendations',
            'available': exists,
            'missing': [] if exists else [filename]
        }

# ==================== HOME PAGE ====================
def render_home():
    """Render perfect home page with full-screen hero"""
    
    # Full Screen Hero Section
    st.markdown("""
    <div class='hero-fullscreen'>
        <div class='hero-content-center'>
            <div class='hero-icon-large'>🎯</div>
            <h1 class='hero-title-large'>Oracle Database Management</h1>
            <p class='hero-subtitle-large'>Enterprise-Grade Unified DBA Toolkit for Professional Database Administration</p>
        </div>
    </div>
    """, unsafe_allow_html=True)
    
    # Content Section
    st.markdown("<div class='content-section'>", unsafe_allow_html=True)
    
    # Welcome Section with Perfect Layout
    st.markdown("""
    <div class='welcome-container'>
        <div class='welcome-box'>
            <h2>👋 Welcome to Your Command Center</h2>
            <p class='welcome-text'>
                Experience professional Oracle database management with our unified dashboard. 
                This comprehensive toolkit combines three powerful DBA modules into a single, 
                elegant interface. Analyze health checks, parse alert logs, and dive deep into 
                AWR reports with exceptional ease and clarity.
            </p>
        </div>

    </div>
    """, unsafe_allow_html=True)
    
    # Module Cards Section with Perfect Layout
    st.markdown("<div class='section-header'>🛠️ Available Modules</div>", unsafe_allow_html=True)
    
    st.markdown("<div class='modules-grid'>", unsafe_allow_html=True)
    
    col1, col2, col3 = st.columns(3)
    columns = [col1, col2, col3]
    module_keys = ['health_check', 'alert_log', 'awr']
    
    for idx, (col, module_key) in enumerate(zip(columns, module_keys)):
        with col:
            status = MODULES_STATUS[module_key]
            card_class = "module-card" if status['available'] else "module-card disabled"
            status_class = "status-available" if status['available'] else "status-unavailable"
            status_text = "✅ Available" if status['available'] else "❌ Unavailable"
            
            st.markdown(f"""
            <div class='{card_class}'>
                <div class='module-icon'>{status['icon']}</div>
                <h3>{status['title']}</h3>
                <p>{status['description']}</p>
            </div>
            """, unsafe_allow_html=True)
            
            if status['available']:
                if st.button(f"Launch {status['title']}", key=f"launch_{module_key}", use_container_width=True):
                    st.session_state.current_module = module_key
                    st.session_state.show_module_content = True
                    
                    if module_key == 'health_check':
                        st.session_state.stats['health_checks'] += 1
                    elif module_key == 'alert_log':
                        st.session_state.stats['logs_analyzed'] += 1
                    elif module_key == 'awr':
                        st.session_state.stats['awr_reports'] += 1
                    
                    st.rerun()
            else:
                st.error(f"**Missing files:** {', '.join(status['missing'])}")
    
    st.markdown("</div>", unsafe_allow_html=True)
    
    # Statistics Section
    st.markdown("<div class='section-header'>📊 Usage Statistics</div>", unsafe_allow_html=True)
    
    st.markdown("<div class='stats-grid'>", unsafe_allow_html=True)
    
    col1, col2, col3, col4 = st.columns(4)
    
    with col1:
        st.markdown(f"""
        <div class='stat-card'>
            <div class='stat-number'>{st.session_state.stats['health_checks']}</div>
            <div class='stat-label'>Health Checks</div>
        </div>
        """, unsafe_allow_html=True)
    
    with col2:
        st.markdown(f"""
        <div class='stat-card'>
            <div class='stat-number'>{st.session_state.stats['logs_analyzed']}</div>
            <div class='stat-label'>Logs Analyzed</div>
        </div>
        """, unsafe_allow_html=True)
    
    with col3:
        st.markdown(f"""
        <div class='stat-card'>
            <div class='stat-number'>{st.session_state.stats['awr_reports']}</div>
            <div class='stat-label'>AWR Reports</div>
        </div>
        """, unsafe_allow_html=True)
    
    with col4:
        total = (st.session_state.stats['health_checks'] + 
                st.session_state.stats['logs_analyzed'] + 
                st.session_state.stats['awr_reports'])
        st.markdown(f"""
        <div class='stat-card'>
            <div class='stat-number'>{total}</div>
            <div class='stat-label'>Total Operations</div>
        </div>
        """, unsafe_allow_html=True)
    
    st.markdown("</div>", unsafe_allow_html=True)
    
    st.markdown("</div>", unsafe_allow_html=True)


# ==================== MODULE CONTENT DISPLAY WITH SIDEBAR FIX ====================
def show_module_with_back_button(module_name, module_file):
    """Display module content with proper styling"""
    
    # Add a failsafe back button in the sidebar
    with st.sidebar:
        st.markdown("---")
        if st.button("🏠 Back to Dashboard", key=f"sidebar_back_{module_name.replace(' ', '_')}", use_container_width=True):
            st.session_state.show_module_content = False
            st.session_state.current_module = 'home'
            st.rerun()
        st.markdown("---")
    
    # Clear dashboard styling for clean module display
    st.markdown("""
    <style>
    /* Remove dashboard gradient background */
    html, body, [data-testid="stAppViewContainer"], [data-testid="stApp"] {
        background: #ffffff !important;
        animation: none !important;
    }
    
    /* Reset all padding */
    .main, .block-container {
        padding: 0 !important;
        max-width: 100% !important;
    }
    
    /* ==================== CRITICAL SIDEBAR TOGGLE FIX ==================== */
    /* These rules ensure the toggle button is ALWAYS visible and functional */
    
    /* Collapsed sidebar toggle button - FORCE VISIBILITY */
    [data-testid="collapsedControl"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        position: fixed !important;
        top: 0.5rem !important;
        left: 0.5rem !important;
        z-index: 2147483647 !important;
    }
    
    /* The actual button inside the collapsed control */
    [data-testid="collapsedControl"] button {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        background: rgba(255, 255, 255, 0.95) !important;
        border-radius: 8px !important;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15) !important;
        transition: all 0.3s ease !important;
    }
    
    [data-testid="collapsedControl"] button:hover {
        background: rgba(255, 255, 255, 1) !important;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2) !important;
        transform: scale(1.05) !important;
    }
    
    /* Expanded sidebar toggle button */
    [data-testid="stSidebarCollapsedControl"] {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
    }
    
    /* Base sidebar styling */
    [data-testid="stSidebar"] {
        z-index: 999998 !important;
    }
    
    /* Ensure sidebar content doesn't overlap toggle */
    [data-testid="stSidebar"] > div:first-child {
        padding-top: 4rem !important;
    }
    
    /* ==================== SIDEBAR BACK BUTTON STYLING ==================== */
    /* Style the sidebar back button with purple gradient */
    [data-testid="stSidebar"] button,
    [data-testid="stSidebar"] .stButton button {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        color: white !important;
        border: 2px solid transparent !important;
        padding: 0.75rem 1.5rem !important;
        border-radius: 50px !important;
        font-size: 0.9rem !important;
        font-weight: 700 !important;
        letter-spacing: 0.5px !important;
        text-transform: uppercase !important;
        box-shadow: 0 4px 20px rgba(107, 127, 237, 0.4) !important;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
        cursor: pointer !important;
        width: 100% !important;
        min-height: 42px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 0.5rem !important;
        white-space: nowrap !important;
    }
    
    [data-testid="stSidebar"] button:hover,
    [data-testid="stSidebar"] .stButton button:hover {
        background: linear-gradient(135deg, #7B8FF5 0%, #9B7FC8 100%) !important;
        box-shadow: 0 6px 30px rgba(107, 127, 237, 0.6) !important;
        transform: translateY(-2px) scale(1.02) !important;
        border: 2px solid rgba(255, 255, 255, 0.3) !important;
    }
    
    [data-testid="stSidebar"] button:active,
    [data-testid="stSidebar"] .stButton button:active {
        transform: translateY(0) scale(1.0) !important;
        box-shadow: 0 4px 15px rgba(107, 127, 237, 0.4) !important;
    }
    
    /* ==================== BACK BUTTON BANNER STYLING ==================== */
    /* Ensure containers don't clip the button */
    .main, .block-container, [data-testid="stAppViewContainer"] {
        overflow: visible !important;
    }
    
    /* Create proper spacing and container for back button */
    .back-button-wrapper {
        width: 100% !important;
        padding: 0.5rem 1rem !important;
        margin: 0 !important;
        display: flex !important;
        justify-content: center !important;
        align-items: center !important;
        background: transparent !important;
        overflow: visible !important;
    }
    
    .back-button-header {
        width: 100% !important;
        max-width: 600px !important;
        display: flex !important;
        justify-content: center !important;
        align-items: center !important;
        padding: 0 !important;
        margin: 0 auto !important;
        overflow: visible !important;
    }
    
    /* Ensure button containers are visible */
    .back-button-header .stButton,
    .back-button-wrapper .stButton,
    div[data-testid="column"] .stButton {
        display: flex !important;
        justify-content: center !important;
        align-items: center !important;
        width: 100% !important;
        overflow: visible !important;
        margin: 0 !important;
        padding: 0 !important;
    }
    
    /* Style the back button itself with high specificity */
    .back-button-header button,
    .back-button-wrapper button,
    button[data-testid="baseButton-secondary"] {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
        color: white !important;
        border: 2px solid transparent !important;
        padding: 0.75rem 2rem !important;
        border-radius: 50px !important;
        font-size: 0.95rem !important;
        font-weight: 700 !important;
        letter-spacing: 1px !important;
        text-transform: uppercase !important;
        box-shadow: 0 4px 20px rgba(107, 127, 237, 0.4) !important;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
        cursor: pointer !important;
        width: 100% !important;
        max-width: 350px !important;
        min-height: 45px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 0.5rem !important;
        white-space: nowrap !important;
    }
    
    .back-button-header button:hover,
    .back-button-wrapper button:hover,
    button[data-testid="baseButton-secondary"]:hover {
        background: linear-gradient(135deg, #7B8FF5 0%, #9B7FC8 100%) !important;
        box-shadow: 0 6px 30px rgba(107, 127, 237, 0.6) !important;
        transform: translateY(-2px) scale(1.02) !important;
        border: 2px solid rgba(255, 255, 255, 0.3) !important;
    }
    
    .back-button-header button:active,
    .back-button-wrapper button:active,
    button[data-testid="baseButton-secondary"]:active {
        transform: translateY(0) scale(1.0) !important;
        box-shadow: 0 4px 15px rgba(107, 127, 237, 0.4) !important;
    }
    </style>
    """, unsafe_allow_html=True)
    
    # Only show back button if module has finished loading
    if st.session_state.get('module_loaded', False):
        # Create a prominent back button with proper spacing and wrapper
        st.markdown('<div class="back-button-wrapper"><div class="back-button-header">', unsafe_allow_html=True)
        
        # Use unique key based on module name to prevent conflicts
        button_key = f"back_btn_{module_name.replace(' ', '_')}"
        
        # Create centered button without columns to avoid width constraints
        if st.button("← BACK TO DASHBOARD", key=button_key, use_container_width=True):
            # Clear all session state related to modules
            st.session_state.show_module_content = False
            st.session_state.current_module = 'home'
            st.session_state.module_loaded = False
            # Force a clean rerun
            st.rerun()
        
        st.markdown('</div></div>', unsafe_allow_html=True)
    
    # Execute the module - let it display its own UI with its own styling
    try:
        with open(module_file, 'r', encoding='utf-8', errors='ignore') as f:
            code = f.read()
        
        # Remove st.set_page_config from module code as it's already set
        code = re.sub(r'st\.set_page_config\([^)]*\)', '', code)
        
        # Execute the module code
        exec(code, globals())
    except Exception as e:
        st.error(f"❌ **Error loading module:** {str(e)}")
        
        with st.expander("🔍 View Error Details"):
            st.code(str(e))
            import traceback
            st.code(traceback.format_exc())



# ==================== MAIN ROUTING ====================
def main():
    """Main application router"""
    
    # IMMEDIATELY hide home content if showing a module
    if st.session_state.show_module_content:
        # Add CSS to immediately hide ANY and ALL home content during loading
        st.markdown("""
        <style>
        /* CRITICAL: Hide EVERYTHING from home page immediately when module is active */
        .hero-fullscreen,
        .hero-content-center,
        .hero-icon-large,
        .hero-title-large,
        .hero-subtitle-large,
        .content-section,
        .welcome-container,
        .welcome-box,
        .modules-grid,
        .module-card,
        .section-header,
        .footer,
        .stats-container,
        .stats-grid,
        .stat-card,
        .stat-number,
        .stat-label,
        div[class*="stat"],
        div[class*="hero"],
        div[class*="welcome"],
        div[class*="module"],
        .back-button-wrapper,
        .back-button-header {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            height: 0 !important;
            overflow: hidden !important;
            position: absolute !important;
            left: -9999px !important;
        }
        
        /* Also hide Streamlit column containers that contain home content */
        .main > div:not(.back-button-wrapper):not(.back-button-header) {
            display: none !important;
        }
        
        /* Style for loading container */
        .module-loading {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 60vh;
            flex-direction: column;
            background: white;
        }
        </style>
        """, unsafe_allow_html=True)
        
        # Show loading message immediately
        loading_container = st.empty()
        with loading_container.container():
            st.markdown("""
            <div class='module-loading'>
                <div style='font-size: 3rem; color: #6B7FED; margin-bottom: 1.5rem; animation: pulse 1.5s ease-in-out infinite;'>
                    ⏳
                </div>
                <div style='font-size: 1.4rem; font-weight: 600; color: #333; margin-bottom: 0.5rem;'>
                    Loading Module...
                </div>
                <div style='font-size: 1rem; color: #666;'>
                    Please wait while we prepare your analyzer
                </div>
            </div>
            <style>
            @keyframes pulse {
                0%, 100% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.1); opacity: 0.8; }
            }
            </style>
            """, unsafe_allow_html=True)
        
        # Return early - don't execute any code below
        module = st.session_state.current_module
        
        # Clear loading message before showing module
        loading_container.empty()
        
        # Set flag to indicate module has loaded (this will show the back button)
        st.session_state.module_loaded = True
        
        # Add CSS to reveal back button now that loading is complete
        st.markdown("""
        <style>
        /* Reveal back button after loading */
        .back-button-wrapper,
        .back-button-header {
            display: flex !important;
            visibility: visible !important;
            opacity: 1 !important;
            height: auto !important;
            overflow: visible !important;
            position: relative !important;
            left: 0 !important;
        }
        </style>
        """, unsafe_allow_html=True)
        
        if module == 'health_check':
            show_module_with_back_button('Health Check Module', 'Checkup.py')
        elif module == 'alert_log':
            show_module_with_back_button('Alert Log Analyzer', 'Alert.py')
        elif module == 'awr':
            show_module_with_back_button('AWR Analyzer', 'app.py')
        return  # Exit main() early to prevent any home content from rendering
    # Only render home if NOT showing module (this shouldn't execute if module is active due to early return)
    render_home()
    
    st.markdown(f"""
    <div class='footer'>
        <p><strong>Oracle Database Management Dashboard v8.0.0</strong></p>
        <p>Built with ❤️ for Oracle DBAs | © {datetime.now().year}</p>
        <p style='font-size: 0.95rem;'>
            Powered by Streamlit | Professional Enterprise Toolkit
        </p>
    </div>
    """, unsafe_allow_html=True)

if __name__ == "__main__":
    # Only apply dashboard styles when on home page
    if not st.session_state.get('show_module_content', False):
        apply_perfect_styles()
    main()