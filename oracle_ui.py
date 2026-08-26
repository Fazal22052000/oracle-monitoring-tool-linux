#oracle_ui

"""
Oracle Database UI - FIXED VERSION
Correctly stores and displays results after execution
"""

import streamlit as st
import pandas as pd
from datetime import datetime
from io import BytesIO
from oracle_functions import (
    create_oracle_connection, 
    test_connection, 
    execute_health_check_script,
    save_html_report
)
import time as time_module
import base64


def render_database_connection_ui():
    """Database connection form"""
    
    if 'db_connected' not in st.session_state:
        st.session_state.db_connected = False
    if 'db_connection' not in st.session_state:
        st.session_state.db_connection = None
    if 'connection_details' not in st.session_state:
        st.session_state.connection_details = {}
    
    with st.expander("🔧 Database Connection Settings", expanded=not st.session_state.db_connected):
        
        col1, col2 = st.columns(2)
        
        with col1:
            username = st.text_input("Username", value=st.session_state.connection_details.get('username', ''), key="db_username_input")
            host = st.text_input("Host", value=st.session_state.connection_details.get('host', 'localhost'), key="db_host_input")
            service_name = st.text_input("Service Name", value=st.session_state.connection_details.get('service_name', 'ORCL'), key="db_service_input")
        
        with col2:
            password = st.text_input("Password", type="password", key="db_password_input")
            port = st.text_input("Port", value=st.session_state.connection_details.get('port', '1521'), key="db_port_input")
        
        col_btn1, col_btn2, col_btn3 = st.columns(3)
        
        with col_btn1:
            if st.button("🔍 Test Connection", use_container_width=True):
                if not all([username, password, host, port, service_name]):
                    st.error("❌ Please fill in all fields")
                else:
                    with st.spinner("Testing..."):
                        success, message = test_connection(username, password, host, port, service_name)
                        if success:
                            st.success(message)
                        else:
                            st.error(message)
        
        with col_btn2:
            if st.button("✅ Connect", use_container_width=True, type="primary"):
                if not all([username, password, host, port, service_name]):
                    st.error("❌ Please fill in all fields")
                else:
                    with st.spinner("Connecting..."):
                        conn, error = create_oracle_connection(username, password, host, port, service_name)
                        if conn:
                            st.session_state.db_connection = conn
                            st.session_state.db_connected = True
                            st.session_state.connection_details = {
                                'username': username,
                                'host': host,
                                'port': port,
                                'service_name': service_name
                            }
                            st.success("✅ Connected!")
                            st.rerun()
                        else:
                            st.error(f"❌ Failed: {error}")
        
        with col_btn3:
            if st.session_state.db_connected:
                if st.button("🔌 Disconnect", use_container_width=True):
                    if st.session_state.db_connection:
                        st.session_state.db_connection.close()
                    st.session_state.db_connected = False
                    st.session_state.db_connection = None
                    st.success("✅ Disconnected")
                    st.rerun()
    
    if st.session_state.db_connected:
        st.success(f"🟢 Connected: {st.session_state.connection_details.get('username')}@{st.session_state.connection_details.get('host')}")
    else:
        st.info("🔴 Not connected")
    
    return st.session_state.db_connected, st.session_state.db_connection


def render_health_check_execution_ui(connection):
    """Execute health check and show results - FIXED VERSION"""
    
    if 'uploaded_script_path' not in st.session_state:
        st.error("❌ No script uploaded. Upload CHECKUP_NEW.txt first.")
        return
    
    temp_script_path = st.session_state.uploaded_script_path
    
    # TWO BUTTONS - Execute and View Raw HTML
    col_exec, col_raw = st.columns(2)
    
    with col_exec:
        execute_btn = st.button(
            "🚀 Execute Health Check on Database",
            use_container_width=True,
            type="primary",
            key="execute_health_check_btn",
            disabled=st.session_state.get('execution_complete', False)
        )
    
    with col_raw:
        show_raw_html = st.button(
            "📄 View Raw HTML Output",
            use_container_width=True,
            disabled='last_generated_html' not in st.session_state,
            key="view_raw_html_btn"
        )
    
    # Show execution status
    if st.session_state.get('execution_complete', False):
        st.success("✅ Health check completed! Results are displayed below.")
        
        col1, col2 = st.columns(2)
        
        with col1:
            if st.button("🔄 Run Health Check Again", use_container_width=True, key="rerun_health_check"):
                # Clear all execution-related session state
                st.session_state.execution_complete = False
                st.session_state.realtime_execution = False
                if 'results' in st.session_state:
                    del st.session_state.results
                if 'db_info' in st.session_state:
                    del st.session_state.db_info
                if 'last_generated_html' in st.session_state:
                    del st.session_state.last_generated_html
                if 'last_generated_filename' in st.session_state:
                    del st.session_state.last_generated_filename
                st.rerun()
        
        with col2:
            st.markdown("""
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        color: white; padding: 15px; border-radius: 10px; text-align: center;
                        animation: pulse 2s ease-in-out infinite;">
                <strong>👇 SCROLL DOWN</strong> to view complete dashboard!
            </div>
            <style>
                @keyframes pulse {
                    0%, 100% { opacity: 1; transform: translateY(0); }
                    50% { opacity: 0.8; transform: translateY(-5px); }
                }
            </style>
            """, unsafe_allow_html=True)
    
    # Show Raw HTML Output
    # Show Raw HTML Output - Download Only
    if show_raw_html and 'last_generated_html' in st.session_state:
        st.markdown("---")
        st.markdown("### 📄 Raw HTML Output")
    
        st.download_button(
            "📥 Download Raw HTML File",
            st.session_state.last_generated_html.encode('utf-8'),
            st.session_state.last_generated_filename,
            "text/html",
            use_container_width=True,
            key="download_raw_html"
        )
    
    # 🔥 EXECUTE BUTTON LOGIC - COMPLETELY FIXED
    if execute_btn:
        progress_bar = st.progress(0)
        status_text = st.empty()
        log_container = st.expander("📋 Execution Log", expanded=False)
        
        def update_progress(percent, message):
            progress_bar.progress(percent / 100)
            status_text.info(f"⏳ {message}...")
        
        try:
            start_time = time_module.time()
            
            # Execute script
            status_text.info("🔄 Executing SQL script on database...")
            html_content, execution_log = execute_health_check_script(
                connection,
                temp_script_path,
                update_progress
            )
            
            execution_time = time_module.time() - start_time
            
            with log_container:
                st.code(execution_log, language="text")
            
            if html_content and len(html_content) > 100:
                # Get comprehensive database info
                from oracle_functions import get_database_info
                live_db_info = get_database_info(connection)
    
                # Get database name for filename
                db_name = live_db_info.get("Database Name", "Unknown")
                
                # Save HTML report
                filepath, filename = save_html_report(html_content, db_name)
                
                # Store raw HTML
                st.session_state.last_generated_html = html_content
                st.session_state.last_generated_filename = filename
                
                progress_bar.progress(95)
                status_text.success(f"✅ Script executed in {execution_time:.2f}s")
                
                # 🔥 CRITICAL FIX: Parse HTML and store results
                status_text.info("📊 Analyzing HTML output...")
                
                try:
                    # Import analyze_report
                    from analysis_utils import analyze_report
                    
                    # 🔥 KEY FIX: Clear Streamlit cache to force fresh parsing
                    if hasattr(analyze_report, 'clear'):
                        analyze_report.clear()
                    
                    # 🔥 DEBUG: Show HTML sample before parsing
                    with st.expander("🔍 DEBUG: HTML Content Preview", expanded=False):
                        st.write(f"HTML Length: {len(html_content):,} characters")
                        st.write("First 1000 chars:")
                        st.code(html_content[:1000], language="html")
                    
                    # Parse the HTML
                    results, db_info = analyze_report(html_content)
                    
                    # 🔥 CRITICAL: Verify parsing worked
                    if results is None:
                        st.error("❌ analyze_report returned None for results!")
                        results = {}
                    
                    if not isinstance(results, dict):
                        st.error(f"❌ analyze_report returned wrong type: {type(results)}")
                        results = {}
                    
                    # 🔥 DEBUG: Show what was parsed - DETAILED VERSION
                    with st.expander("🔍 DEBUG: Parsed Results", expanded=True):
                        st.write(f"**Results Type**: {type(results)}")
                        st.write(f"**Number of Sections**: {len(results)}")
                        
                        if len(results) > 0:
                            st.write("**Section Names, Row Counts, and Column Names**:")
                            for section_name, df in results.items():
                                st.write(f"**{section_name}**: {len(df)} rows, {len(df.columns)} columns")
                                st.write(f"  Columns: {list(df.columns)}")
                                
                                # Show first 3 rows of data
                                if len(df) > 0:
                                    st.write("  First 3 rows:")
                                    st.dataframe(df.head(3), use_container_width=True)
                                else:
                                    st.write("  (No data rows)")
                                st.write("---")
                        else:
                            st.error("⚠️ Results dictionary is EMPTY!")
                            st.write("This means analyze_report failed to extract any data.")
                            st.write("Checking HTML structure...")
                            
                            # Try to find what's in the HTML
                            from bs4 import BeautifulSoup
                            soup = BeautifulSoup(html_content, "html.parser")
                            
                            # Find all headers
                            st.write("**Found Headers in HTML:**")
                            for tag_name in ["h1", "h2", "h3"]:
                                headers = soup.find_all(tag_name)
                                if headers:
                                    st.write(f"  {tag_name.upper()} tags:")
                                    for h in headers[:10]:  # Show first 10
                                        st.write(f"    - {h.get_text(strip=True)}")
                            
                            # Find all tables
                            tables = soup.find_all("table")
                            st.write(f"**Found {len(tables)} tables in HTML**")
                    
                    # 🔥 STORE IN SESSION STATE
                    st.session_state.results = results
                    st.session_state.db_info = db_info if db_info else live_db_info 
                    st.session_state.realtime_execution = True
                    st.session_state.execution_complete = True
                    st.session_state.data_source_mode = 'database'
                    
                    progress_bar.progress(100)
                    
                    # 🔥 FINAL VERIFICATION
                    if len(results) > 0:
                        status_text.success(f"✅ Analysis complete! Found {len(results)} sections.")
                        
                        # Show success
                        st.balloons()
                        
                        # Give user time to see success message
                        time_module.sleep(1)
                        
                        # Force refresh to show dashboard
                        st.rerun()
                    
                    else:
                        st.error("❌ No data sections found in HTML output!")
                        st.warning("The script executed but no data was extracted. This could mean:")
                        st.write("- The HTML structure doesn't match expected format")
                        st.write("- No data exists for the queried sections")
                        st.write("- Parsing logic needs adjustment")
                        
                        # Still allow download
                        st.download_button(
                            "📥 Download Raw HTML (for manual inspection)",
                            html_content.encode('utf-8'),
                            filename,
                            "text/html",
                            use_container_width=True,
                            key="download_empty_html"
                        )
                
                except Exception as parse_error:
                    st.error(f"❌ Analysis failed: {str(parse_error)}")
                    
                    import traceback
                    with st.expander("🔍 Full Error Traceback"):
                        st.code(traceback.format_exc(), language="text")
                    
                    # Show HTML for debugging
                    with st.expander("🔍 Debug: View Generated HTML"):
                        st.code(html_content[:2000], language="html")
                    
                    st.warning("💾 HTML was generated but analysis failed. You can still download it:")
                    st.download_button(
                        "📥 Download HTML Report",
                        html_content.encode('utf-8'),
                        filename,
                        "text/html",
                        use_container_width=True,
                        key="download_html_after_error"
                    )
            
            else:
                st.error("❌ Failed to generate HTML report (empty or too short)")
                status_text.error("❌ Execution failed")
                with log_container:
                    st.code(execution_log, language="text")
        
        except Exception as exec_error:
            st.error(f"❌ Execution error: {str(exec_error)}")
            status_text.error("❌ Execution failed")
            
            import traceback
            with log_container:
                st.code(traceback.format_exc(), language="text")