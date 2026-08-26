import streamlit as st
import hashlib

# Toggle authentication
ENABLE_AUTH = False  # Set to False to disable authentication

# Predefined users with SHA-256 hashed passwords
USERS = {
    "fazal": hashlib.sha256("Fazal@2000".encode()).hexdigest(),
}

def check_login(username, password):
    """Verify if the username and password match."""
    hashed_pw = hashlib.sha256(password.encode()).hexdigest()
    return USERS.get(username) == hashed_pw

def login():
    """Professional Oracle-inspired login UI with enhanced smooth animations."""
    st.markdown("""
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Inter:wght@400;500;600&display=swap');
        
        /* Reset and base styling */
        html, body, [data-testid="stAppViewContainer"], .main {
            height: 100vh !important;
            margin: 0 !important;
            padding: 0 !important;
        }

        .block-container {
            padding: 1rem !important;
            max-width: 100% !important;
            height: 100vh !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
        }

        /* Ensure proper viewport sizing */
        [data-testid="stAppViewContainer"] {
            min-height: 100vh;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow-y: auto;
        }

        /* Sophisticated dark background with subtle pattern */
        [data-testid="stAppViewContainer"], 
        [data-testid="stAppViewContainer"] > section {
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 50%, #0f1629 100%) !important;
            position: relative;
        }

        /* Animated geometric background pattern - SMOOTHER */
        [data-testid="stAppViewContainer"]::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-image: 
                radial-gradient(circle at 20% 30%, rgba(220, 38, 38, 0.03) 0%, transparent 50%),
                radial-gradient(circle at 80% 70%, rgba(37, 99, 235, 0.03) 0%, transparent 50%),
                linear-gradient(180deg, transparent 0%, rgba(10, 14, 39, 0.4) 100%);
            animation: backgroundPulse 25s ease-in-out infinite;
            will-change: opacity;
        }

        @keyframes backgroundPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.85; }
        }

        /* Floating orbs animation - SMOOTHER */
        [data-testid="stAppViewContainer"]::after {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: 
                radial-gradient(circle at 30% 40%, rgba(220, 38, 38, 0.08) 0%, transparent 25%),
                radial-gradient(circle at 70% 60%, rgba(37, 99, 235, 0.06) 0%, transparent 25%);
            animation: orbFloat 40s ease-in-out infinite;
            will-change: transform;
        }

        @keyframes orbFloat {
            0%, 100% { transform: translate(0, 0) rotate(0deg); }
            25% { transform: translate(4%, 4%) rotate(90deg); }
            50% { transform: translate(-2%, 6%) rotate(180deg); }
            75% { transform: translate(6%, -2%) rotate(270deg); }
        }

        /* Main container animation - ENHANCED */
        [data-testid="stVerticalBlock"] {
            width: 100%;
            max-width: 900px;
            animation: fadeInScale 1.2s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            z-index: 1;
        }

        @keyframes fadeInScale {
            from {
                opacity: 0;
                transform: scale(0.92) translateY(30px);
                filter: blur(10px);
            }
            to {
                opacity: 1;
                transform: scale(1) translateY(0);
                filter: blur(0);
            }
        }

        /* Login card with glass morphism - ENHANCED SHADOWS */
        .login-card {
            background: rgba(15, 22, 41, 0.75);
            backdrop-filter: blur(50px) saturate(200%);
            -webkit-backdrop-filter: blur(50px) saturate(200%);
            border-radius: 24px;
            box-shadow: 
                0 0 0 1px rgba(255, 255, 255, 0.06),
                0 25px 80px rgba(0, 0, 0, 0.4),
                0 40px 120px rgba(0, 0, 0, 0.25),
                inset 0 1px 0 rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            position: relative;
            overflow: hidden;
            display: grid;
            grid-template-columns: 1fr 1fr;
            max-height: 90vh;
            height: auto;
            transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .login-card:hover {
            transform: translateY(-2px);
            box-shadow: 
                0 0 0 1px rgba(255, 255, 255, 0.08),
                0 30px 100px rgba(0, 0, 0, 0.5),
                0 50px 150px rgba(0, 0, 0, 0.3),
                inset 0 1px 0 rgba(255, 255, 255, 0.08);
        }

        /* Left side - Branding */
        .login-left {
            background: linear-gradient(135deg, rgba(220, 38, 38, 0.12) 0%, rgba(37, 99, 235, 0.12) 100%);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            padding: 30px;
            border-right: 1px solid rgba(255, 255, 255, 0.08);
            position: relative;
        }

        .login-left::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: 
                radial-gradient(circle at 30% 40%, rgba(220, 38, 38, 0.12) 0%, transparent 50%),
                radial-gradient(circle at 70% 60%, rgba(37, 99, 235, 0.12) 0%, transparent 50%);
            animation: brandingPulse 10s ease-in-out infinite;
            will-change: opacity;
        }

        @keyframes brandingPulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
        }

        /* Right side - Form */
        .login-right {
            padding: 30px 40px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            overflow-y: auto;
            max-height: 90vh;
        }

        /* Subtle top gradient accent - SMOOTHER */
        .login-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, 
                transparent 0%, 
                rgba(220, 38, 38, 0.9) 25%, 
                rgba(37, 99, 235, 0.9) 75%, 
                transparent 100%);
            animation: shimmer 4s ease-in-out infinite;
            will-change: opacity;
        }

        @keyframes shimmer {
            0%, 100% { 
                opacity: 0.4;
                transform: scaleX(1);
            }
            50% { 
                opacity: 1;
                transform: scaleX(1.02);
            }
        }

        /* Oracle logo container */
        .oracle-brand {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 15px;
            position: relative;
            z-index: 1;
            text-align: center;
            animation: brandFadeIn 1.5s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both;
        }

        @keyframes brandFadeIn {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* Geometric icon - ENHANCED ANIMATION */
        .brand-icon {
            width: 70px;
            height: 70px;
            background: linear-gradient(135deg, #dc2626 0%, #2563eb 100%);
            border-radius: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 
                0 10px 40px rgba(220, 38, 38, 0.35),
                0 0 0 1px rgba(255, 255, 255, 0.12) inset,
                0 0 60px rgba(220, 38, 38, 0.2);
            position: relative;
            animation: iconPulse 6s ease-in-out infinite;
            transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
            will-change: transform, box-shadow;
        }

        @keyframes iconPulse {
            0%, 100% { 
                transform: scale(1) rotate(0deg); 
                box-shadow: 
                    0 10px 40px rgba(220, 38, 38, 0.35),
                    0 0 0 1px rgba(255, 255, 255, 0.12) inset,
                    0 0 60px rgba(220, 38, 38, 0.2);
            }
            50% { 
                transform: scale(1.08) rotate(5deg); 
                box-shadow: 
                    0 15px 50px rgba(220, 38, 38, 0.5),
                    0 0 0 1px rgba(255, 255, 255, 0.15) inset,
                    0 0 80px rgba(220, 38, 38, 0.3);
            }
        }

        .brand-icon:hover {
            transform: scale(1.12) rotate(-5deg) !important;
            box-shadow: 
                0 20px 60px rgba(220, 38, 38, 0.6),
                0 0 0 1px rgba(255, 255, 255, 0.2) inset,
                0 0 100px rgba(220, 38, 38, 0.4) !important;
        }

        .brand-icon::before {
            content: 'Θ';
            font-size: 40px;
            font-weight: bold;
            color: white;
            font-family: 'Playfair Display', serif;
            animation: iconRotate 8s ease-in-out infinite;
            will-change: transform;
        }

        @keyframes iconRotate {
            0%, 100% { transform: rotate(0deg) scale(1); }
            50% { transform: rotate(360deg) scale(1.1); }
        }

        /* Header styling - ENHANCED */
        .header-title {
            font-family: 'Playfair Display', serif;
            font-size: 1.75rem;
            font-weight: 900;
            background: linear-gradient(135deg, #ffffff 0%, #e2e8f0 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            letter-spacing: -0.5px;
            line-height: 1.2;
            margin: 0;
            text-align: center;
            animation: titleShine 8s ease-in-out infinite;
        }

        @keyframes titleShine {
            0%, 100% { 
                filter: brightness(1);
                text-shadow: 0 2px 20px rgba(255, 255, 255, 0.2);
            }
            50% { 
                filter: brightness(1.2);
                text-shadow: 0 2px 30px rgba(255, 255, 255, 0.4);
            }
        }

        .header-subtitle {
            font-family: 'Inter', sans-serif;
            font-size: 0.85rem;
            color: rgba(226, 232, 240, 0.7);
            font-weight: 500;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            margin-top: 8px;
            text-align: center;
            animation: subtitleFade 10s ease-in-out infinite;
        }

        @keyframes subtitleFade {
            0%, 100% { opacity: 0.7; }
            50% { opacity: 1; }
        }

        /* Brand description */
        .brand-description {
            font-family: 'Inter', sans-serif;
            font-size: 0.85rem;
            color: rgba(226, 232, 240, 0.6);
            line-height: 1.6;
            text-align: center;
            margin-top: 12px;
            max-width: 300px;
            animation: descriptionFadeIn 1.8s cubic-bezier(0.16, 1, 0.3, 1) 0.6s both;
        }

        @keyframes descriptionFadeIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* Form section */
        .form-header {
            margin-bottom: 25px;
            animation: formHeaderFadeIn 1.5s cubic-bezier(0.16, 1, 0.3, 1) 0.4s both;
        }

        @keyframes formHeaderFadeIn {
            from {
                opacity: 0;
                transform: translateX(-20px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }

        .form-title {
            font-family: 'Playfair Display', serif;
            font-size: 1.6rem;
            font-weight: 700;
            color: #f1f5f9;
            margin-bottom: 6px;
        }

        .form-subtitle {
            font-family: 'Inter', sans-serif;
            font-size: 0.9rem;
            color: rgba(226, 232, 240, 0.65);
        }

        /* Input styling - ENHANCED */
        .input-wrapper {
            margin-bottom: 16px;
            animation: inputFadeIn 1.5s cubic-bezier(0.16, 1, 0.3, 1) 0.6s both;
        }

        .input-wrapper:nth-child(2) {
            animation-delay: 0.7s;
        }

        @keyframes inputFadeIn {
            from {
                opacity: 0;
                transform: translateX(-15px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }

        .input-label {
            font-family: 'Inter', sans-serif;
            font-size: 0.8rem;
            color: rgba(226, 232, 240, 0.85);
            font-weight: 600;
            margin-bottom: 6px;
            display: flex;
            align-items: center;
            gap: 6px;
            letter-spacing: 0.3px;
        }

        .input-icon {
            font-size: 1rem;
            opacity: 0.8;
        }

        /* Input fields - SMOOTH TRANSITIONS */
        .stTextInput input {
            background: rgba(30, 41, 59, 0.4) !important;
            border: 1.5px solid rgba(148, 163, 184, 0.2) !important;
            border-radius: 12px !important;
            color: #f1f5f9 !important;
            font-family: 'Inter', sans-serif !important;
            font-size: 0.95rem !important;
            padding: 12px 16px !important;
            transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1) !important;
            backdrop-filter: blur(10px);
        }

        .stTextInput input:hover {
            background: rgba(30, 41, 59, 0.6) !important;
            border-color: rgba(148, 163, 184, 0.35) !important;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15) !important;
        }

        .stTextInput input:focus {
            background: rgba(30, 41, 59, 0.7) !important;
            border-color: rgba(220, 38, 38, 0.5) !important;
            box-shadow: 
                0 0 0 3px rgba(220, 38, 38, 0.1),
                0 6px 30px rgba(220, 38, 38, 0.2) !important;
            outline: none !important;
            transform: translateY(-2px);
        }

        .stTextInput input::placeholder {
            color: rgba(148, 163, 184, 0.5) !important;
            font-size: 0.9rem !important;
        }

        /* Button styling - ENHANCED */
        .stButton {
            margin-top: 20px;
            animation: buttonFadeIn 1.5s cubic-bezier(0.16, 1, 0.3, 1) 0.8s both;
        }

        @keyframes buttonFadeIn {
            from {
                opacity: 0;
                transform: translateY(15px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .stButton button {
            background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%) !important;
            color: white !important;
            border: none !important;
            border-radius: 12px !important;
            padding: 14px 28px !important;
            font-family: 'Inter', sans-serif !important;
            font-size: 1rem !important;
            font-weight: 600 !important;
            letter-spacing: 0.3px !important;
            cursor: pointer !important;
            width: 100% !important;
            box-shadow: 
                0 6px 24px rgba(220, 38, 38, 0.3),
                0 0 0 1px rgba(255, 255, 255, 0.1) inset !important;
            transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1) !important;
            position: relative !important;
            overflow: hidden !important;
        }

        .stButton button::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 0;
            height: 0;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.15);
            transform: translate(-50%, -50%);
            transition: width 0.6s ease, height 0.6s ease;
        }

        .stButton button:hover::before {
            width: 300px;
            height: 300px;
        }

        .stButton button:hover {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important;
            transform: translateY(-3px) !important;
            box-shadow: 
                0 12px 36px rgba(220, 38, 38, 0.45),
                0 0 0 1px rgba(255, 255, 255, 0.15) inset !important;
        }

        .stButton button:active {
            transform: translateY(-1px) !important;
            box-shadow: 
                0 4px 16px rgba(220, 38, 38, 0.3),
                0 0 0 1px rgba(255, 255, 255, 0.1) inset !important;
        }

        /* Footer - ENHANCED */
        .login-footer {
            text-align: center;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            font-size: 0.85rem;
            color: rgba(255, 255, 255, 0.6);
            line-height: 1.6;
            animation: footerFadeIn 1.5s cubic-bezier(0.16, 1, 0.3, 1) 1s both;
        }

        @keyframes footerFadeIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .footer-highlight {
            color: rgba(255, 255, 255, 0.9);
            font-weight: 600;
            transition: color 0.3s ease;
        }

        .footer-highlight:hover {
            color: rgba(220, 38, 38, 0.9);
        }

        /* Success alert - SMOOTH ANIMATION */
        div[data-baseweb="notification"][kind="success"] {
            background: rgba(16, 185, 129, 0.15) !important;
            border-color: rgba(16, 185, 129, 0.3) !important;
            animation: alertSlideIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Warning alert */
        div[data-baseweb="notification"][kind="warning"] {
            background: rgba(245, 158, 11, 0.15) !important;
            border-color: rgba(245, 158, 11, 0.3) !important;
            animation: alertSlideIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Error alert */
        div[data-baseweb="notification"][kind="error"] {
            background: rgba(220, 38, 38, 0.15) !important;
            border-color: rgba(220, 38, 38, 0.3) !important;
            animation: alertSlideIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes alertSlideIn {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* Hide Streamlit branding */
        #MainMenu, footer, header {
            visibility: hidden !important;
        }
        
        [data-testid="stForm"] {
            background: transparent !important;
            border: none !important;
            padding: 0 !important;
            margin: 0 !important;
        }

        /* Optimize spacing */
        [data-testid="stVerticalBlock"] > [style*="flex-direction: column;"] > [data-testid="stVerticalBlock"] {
            gap: 0 !important;
        }

        .element-container {
            margin-bottom: 0 !important;
        }

        /* Grid background effect - ANIMATED */
        .grid-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-image: 
                linear-gradient(rgba(148, 163, 184, 0.03) 1px, transparent 1px),
                linear-gradient(90deg, rgba(148, 163, 184, 0.03) 1px, transparent 1px);
            background-size: 40px 40px;
            pointer-events: none;
            z-index: 0;
            animation: gridMove 60s linear infinite;
            will-change: background-position;
        }

        @keyframes gridMove {
            0% { background-position: 0 0; }
            100% { background-position: 40px 40px; }
        }

        /* Responsive design for smaller screens */
        @media (max-height: 700px) {
            .login-card {
                grid-template-columns: 1fr;
                max-height: 95vh;
            }
            
            .login-left {
                display: none;
            }
            
            .login-right {
                padding: 20px 30px;
            }
            
            .brand-icon {
                width: 60px;
                height: 60px;
            }
            
            .header-title {
                font-size: 1.5rem;
            }
        }

        @media (max-width: 768px) {
            .login-card {
                grid-template-columns: 1fr;
            }
            
            .login-left {
                border-right: none;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                padding: 20px;
            }
        }

        /* Performance optimizations */
        * {
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        </style>
        
        <div class="grid-overlay"></div>
    """, unsafe_allow_html=True)

    # Create centered container
    col1, col2, col3 = st.columns([1, 6, 1])
    
    with col2:
        # Login card with horizontal layout
        st.markdown("""
            <div class="login-card">
                <div class="login-left">
                    <div class="oracle-brand">
                        <div class="brand-icon"></div>
                        <div>
                            <div class="header-title">Oracle AWR<br>Analyzer</div>
                            <div class="header-subtitle">Performance Intelligence Platform</div>
                        </div>
                        <div class="brand-description">
                            Advanced AWR analysis and database performance monitoring for enterprise Oracle environments
                        </div>
                    </div>
                </div>
                <div class="login-right">
                    <div class="form-header">
                        <div class="form-title">Welcome Back</div>
                        <div class="form-subtitle">Sign in to access your dashboard</div>
                    </div>
        """, unsafe_allow_html=True)
        
        # Login form
        with st.container():
            with st.form("login_form"):
                # Username field
                st.markdown("""
                    <div class="input-wrapper">
                        <div class="input-label">
                            <span class="input-icon">👤</span>
                            <span>Username</span>
                        </div>
                    </div>
                """, unsafe_allow_html=True)
                username = st.text_input(
                    "Username", 
                    label_visibility="collapsed", 
                    placeholder="Enter your username", 
                    key="username_input"
                )
                
                # Password field
                st.markdown("""
                    <div class="input-wrapper">
                        <div class="input-label">
                            <span class="input-icon">🔒</span>
                            <span>Password</span>
                        </div>
                    </div>
                """, unsafe_allow_html=True)
                password = st.text_input(
                    "Password", 
                    type="password", 
                    label_visibility="collapsed", 
                    placeholder="Enter your password", 
                    key="password_input"
                )
                
                # Submit button
                submitted = st.form_submit_button("🔐 Secure Sign In")

                if submitted:
                    if not username or not password:
                        st.warning("⚠️ Both username and password are required.")
                    elif check_login(username, password):
                        st.session_state.authenticated = True
                        st.session_state.username = username
                        st.success("✅ Login successful! Redirecting...")
                        st.rerun()
                    else:
                        st.error("❌ Invalid credentials. Please try again.")
        
        # Footer inside right panel
        st.markdown("""
                    <div class="login-footer">
                        <span class="footer-highlight">Oracle AWR Analyzer Pro</span> © 2025<br>
                        Developed by Fazal
                    </div>
                </div>
            </div>
        """, unsafe_allow_html=True)

def logout():
    """Styled logout panel in sidebar."""
    with st.sidebar:
        st.markdown("---")
        st.markdown(f"""
            <div style="
                background: rgba(30, 41, 59, 0.3);
                padding: 12px 16px;
                border-radius: 8px;
                border: 1px solid rgba(148, 163, 184, 0.1);
                margin-bottom: 12px;
            ">
                <div style="
                    font-family: 'Inter', sans-serif;
                    font-size: 0.75rem;
                    color: #94a3b8;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-bottom: 4px;
                ">Logged in as</div>
                <div style="
                    font-family: 'Inter', sans-serif;
                    font-size: 0.95rem;
                    color: #f1f5f9;
                    font-weight: 600;
                ">👤 {st.session_state.username}</div>
            </div>
        """, unsafe_allow_html=True)
        
        if st.button("🔓 Logout", use_container_width=True):
            st.session_state.authenticated = False
            st.session_state.username = ""
            st.rerun()