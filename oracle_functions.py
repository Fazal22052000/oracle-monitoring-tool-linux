#oracle_functions - FIXED VERSION

"""
Oracle Database Connection Functions - IMPROVED
Captures System Configuration Information correctly
"""

import oracledb
import streamlit as st
import os
import tempfile
import time
from datetime import datetime
import pandas as pd

def create_oracle_connection(username, password, host, port, service_name):
    """Connect to Oracle database"""
    try:
        host = host.strip()
        port = str(port).strip()
        service_name = service_name.strip()
        username = username.strip()
        
        dsn = f"{host}:{port}/{service_name}"
        
        if username.lower() == 'sys':
            connection = oracledb.connect(
                user=username, 
                password=password, 
                dsn=dsn,
                mode=oracledb.AUTH_MODE_SYSDBA
            )
        else:
            connection = oracledb.connect(
                user=username, 
                password=password, 
                dsn=dsn
            )
        
        return connection, None
        
    except oracledb.DatabaseError as e:
        error_obj, = e.args
        return None, f"Database Error: {error_obj.message}"
    
    except Exception as e:
        return None, f"Connection failed: {str(e)}"


def test_connection(username, password, host, port, service_name):
    """Test if database connection works"""
    conn, error = create_oracle_connection(username, password, host, port, service_name)
    
    if conn:
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM v$database")
            db_name = cursor.fetchone()[0]
            cursor.close()
            conn.close()
            return True, f"✅ Connected to database: {db_name}"
        except Exception as e:
            conn.close()
            return False, f"❌ Connection OK but query failed: {e}"
    
    return False, error


def get_database_info(connection):
    """
    Extract comprehensive database information - IMPROVED VERSION
    Matches the format shown in your screenshot
    """
    db_info = {}
    
    try:
        cursor = connection.cursor()
        
        # Database Name
        try:
            cursor.execute("SELECT name FROM v$database")
            db_info["Database Name"] = cursor.fetchone()[0]
        except:
            pass
        
        # Database Version (full banner)
        try:
            cursor.execute("SELECT banner FROM v$version WHERE ROWNUM = 1")
            db_info["Database version"] = cursor.fetchone()[0]
        except:
            pass
        
        # Operating System
        try:
            cursor.execute("SELECT PLATFORM_NAME FROM v$database")
            db_info["Operating System"] = cursor.fetchone()[0]
        except:
            pass
        
        # CPU Numbers
        try:
            cursor.execute("SELECT value FROM v$osstat WHERE stat_name = 'NUM_CPUS'")
            result = cursor.fetchone()
            if result:
                db_info["CPU numbers"] = str(result[0])
        except:
            try:
                cursor.execute("SELECT value FROM v$parameter WHERE name = 'cpu_count'")
                result = cursor.fetchone()
                if result:
                    db_info["CPU numbers"] = str(result[0])
            except:
                pass
        
        # Physical Memory
        try:
            cursor.execute("SELECT value FROM v$osstat WHERE stat_name = 'PHYSICAL_MEMORY_BYTES'")
            result = cursor.fetchone()
            if result:
                memory_gb = int(result[0]) / (1024**3)
                db_info["Physical Memory"] = f"{memory_gb:.0f}GB"
        except:
            pass
        
        cursor.close()
        
    except Exception as e:
        print(f"Error extracting database info: {str(e)}")
    
    return db_info


def execute_health_check_script(connection, script_path, progress_callback=None):
    """
    Run health check SQL script - IMPROVED VERSION
    Includes System_Configuration_Information section at the top
    """
    
    cursor = connection.cursor()
    execution_log = []
    html_parts = []
    
    try:
        # Get database info first
        db_info = get_database_info(connection)
        
        # Read SQL script
        with open(script_path, 'r', encoding='utf-8', errors='ignore') as f:
            script_content = f.read()
        
        execution_log.append(f"📄 Script loaded: {os.path.basename(script_path)}")
        
        if progress_callback:
            progress_callback(10, "Script loaded")
        
        # Start HTML document
        html_parts.append("""
<!DOCTYPE html>
<html>
<head>
    <title>DB Health Check Report</title>
    <meta charset="UTF-8">
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f7fa;
            color: #2c3e50;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            border-bottom: 4px solid #3498db;
            padding-bottom: 15px;
            margin-top: 40px;
            margin-bottom: 20px;
            font-size: 24px;
            font-weight: 600;
        }
        h1:first-of-type {
            margin-top: 0;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin: 20px 0 40px 0;
            background: white;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            border-radius: 8px;
            overflow: hidden;
        }
        thead {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        th {
            color: white;
            padding: 15px 12px;
            text-align: left;
            font-weight: 600;
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        td {
            padding: 12px;
            border-bottom: 1px solid #ecf0f1;
            font-size: 14px;
        }
        tr:last-child td {
            border-bottom: none;
        }
        tbody tr {
            transition: background-color 0.2s ease;
        }
        tbody tr:nth-child(even) {
            background: #f8f9fa;
        }
        tbody tr:hover {
            background: #e3f2fd;
        }
        .header-banner {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 50px 30px;
            border-radius: 10px;
            text-align: center;
            margin-bottom: 40px;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
        }
        .header-banner h1 {
            color: white;
            border: none;
            margin: 0;
            font-size: 36px;
            font-weight: 700;
        }
        .header-banner p {
            margin: 15px 0 0 0;
            opacity: 0.95;
            font-size: 16px;
        }
        .db-info-section {
            background: #f8f9fa;
            padding: 25px;
            border-radius: 10px;
            margin-bottom: 40px;
            border-left: 5px solid #3498db;
        }
        .db-info-section h1 {
            margin-top: 0;
            color: #2c3e50;
        }
        .db-info-item {
            padding: 10px 0;
            border-bottom: 1px solid #dee2e6;
            display: flex;
        }
        .db-info-item:last-child {
            border-bottom: none;
        }
        .db-info-label {
            font-weight: 600;
            color: #495057;
            width: 200px;
            flex-shrink: 0;
        }
        .db-info-value {
            color: #2c3e50;
            flex-grow: 1;
        }
        .section {
            margin-bottom: 50px;
        }
        .no-data {
            text-align: center;
            padding: 30px;
            color: #95a5a6;
            font-style: italic;
            background: #ecf0f1;
            border-radius: 8px;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-banner">
            <h1>Database Health Check Report</h1>
            <p>Generated: """ + datetime.now().strftime("%B %d, %Y at %I:%M %p") + """</p>
        </div>
""")
        
        # Add System Configuration Information section
        if db_info:
            html_parts.append("""
        <div class="db-info-section">
            <h1>SYSTEM_CONFIGURATION_INFORMATION:</h1>
            <div style="margin-top: 20px;">
                <div style="font-weight: 600; margin-bottom: 15px;">System_Configuration_Information :</div>
""")
            
            for key, value in db_info.items():
                html_parts.append(f"""
                <div class="db-info-item">
                    <div class="db-info-label">{key} ::</div>
                    <div class="db-info-value">{value}</div>
                </div>
""")
            
            html_parts.append("""
            </div>
        </div>
""")
        
        # Parse and execute SQL sections
        lines = script_content.split('\n')
        current_section = {'header': None, 'query': []}
        sections = []
        
        for line in lines:
            line_stripped = line.strip()
            
            if not line_stripped or line_stripped.startswith('--') or \
               line_stripped.startswith('SET ') or line_stripped.startswith('COL') or \
               line_stripped.startswith('COLUMN') or line_stripped.upper().startswith('SPOOL'):
                continue
            
            if line_stripped.upper().startswith('PROMPT'):
                if current_section['header'] or current_section['query']:
                    sections.append(current_section)
                    current_section = {'header': None, 'query': []}
                
                if '<h1' in line_stripped or '<h2' in line_stripped or '<h3' in line_stripped:
                    start = line_stripped.find('<h')
                    if '<h1' in line_stripped:
                        end = line_stripped.find('</h1>') + 5
                    elif '<h2' in line_stripped:
                        end = line_stripped.find('</h2>') + 5
                    else:
                        end = line_stripped.find('</h3>') + 5
                    
                    if start != -1 and end > 4:
                        header_html = line_stripped[start:end]
                        header_text = header_html.replace('<h1 style="font-size:18pt; font-family:Georgia;">', '')
                        header_text = header_text.replace('</h1>', '').replace('</h2>', '').replace('</h3>', '')
                        current_section['header'] = header_text.strip()
                continue
            
            current_section['query'].append(line_stripped)
        
        if current_section['header'] or current_section['query']:
            sections.append(current_section)
        
        total_sections = len(sections)
        execution_log.append(f"📊 Total sections parsed: {total_sections}")
        
        successful_queries = 0
        
        # Execute each section
        for idx, section in enumerate(sections):
            try:
                progress_pct = int(10 + (idx / total_sections) * 85)
                
                if progress_callback:
                    progress_callback(progress_pct, f"Processing section {idx+1}/{total_sections}")
                
                if section['header']:
                    html_parts.append(f'<div class="section">')
                    html_parts.append(f'<h1>{section["header"]}</h1>')
                
                if section['query']:
                    query = '\n'.join(section['query']).strip().rstrip(';')
                    
                    if query and len(query) > 5 and query.upper().startswith('SELECT'):
                        try:
                            cursor.execute(query)
                            
                            if cursor.description:
                                columns = [desc[0] for desc in cursor.description]
                                rows = cursor.fetchall()
                                
                                if rows:
                                    # Remove duplicates
                                    unique_rows = []
                                    seen = set()
                                    for row in rows:
                                        row_tuple = tuple(str(x) if x is not None else '' for x in row)
                                        if row_tuple not in seen:
                                            seen.add(row_tuple)
                                            unique_rows.append(row)
                                    
                                    html_parts.append("<table><thead><tr>")
                                    for col in columns:
                                        html_parts.append(f"<th>{col}</th>")
                                    html_parts.append("</tr></thead><tbody>")
                                    
                                    for row in unique_rows:
                                        html_parts.append("<tr>")
                                        for cell in row:
                                            cell_value = "" if cell is None else str(cell)
                                            html_parts.append(f"<td>{cell_value}</td>")
                                        html_parts.append("</tr>")
                                    html_parts.append("</tbody></table>")
                                    
                                    successful_queries += 1
                                    execution_log.append(f"✓ Section '{section['header']}': {len(unique_rows)} unique rows")
                                else:
                                    html_parts.append('<div class="no-data">No data available</div>')
                        
                        except Exception as query_error:
                            error_msg = str(query_error)
                            if "ORA-00933" not in error_msg:
                                html_parts.append(f'<div class="no-data">Error: {error_msg}</div>')
                
                if section['header']:
                    html_parts.append('</div>')
            
            except Exception as section_error:
                execution_log.append(f"⚠️ Section {idx+1} error: {str(section_error)}")
        
        # Close HTML
        html_parts.append("""
    </div>
</body>
</html>
""")
        
        final_html = ''.join(html_parts)
        
        if progress_callback:
            progress_callback(100, "Complete!")
        
        execution_log.append(f"✅ Execution completed!")
        execution_log.append(f"📊 Statistics:")
        execution_log.append(f"   - Total sections: {total_sections}")
        execution_log.append(f"   - Successful queries: {successful_queries}")
        execution_log.append(f"   - HTML size: {len(final_html):,} characters")
        
        return final_html, '\n'.join(execution_log)
    
    except Exception as e:
        error_msg = f"❌ Critical error: {str(e)}"
        execution_log.append(error_msg)
        import traceback
        execution_log.append(traceback.format_exc())
        return None, '\n'.join(execution_log)
    
    finally:
        cursor.close()


def save_html_report(html_content, db_name):
    """Save HTML report to file"""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"DB_Status_{db_name}_{timestamp}.html"
    
    temp_dir = tempfile.gettempdir()
    filepath = os.path.join(temp_dir, filename)
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(html_content)
    
    return filepath, filename