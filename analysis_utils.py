#analysis_utils - ULTRA-ROBUST SQL*PLUS PARSER - IMPROVED VERSION

"""
Oracle HTML Parser - HANDLES ALL FORMATS
✅ SQL*Plus generated HTML (DB_Status_EQNLOPRD.html format)
✅ Modern styled HTML
✅ Tables with/without proper structure
✅ Multiple header detection strategies
✅ Enhanced diagnostics and logging
✅ Backward compatible with existing code

USAGE:
    # Simple usage (backward compatible)
    results, db_info = analyze_report(html_content)
    
    # With verbose logging
    results, db_info = analyze_report(html_content, verbose=True)
    
    # With parsing log for diagnostics
    results, db_info, log = analyze_report(html_content, return_log=True)
"""

import pandas as pd
from bs4 import BeautifulSoup
import re
import sys


def clean_text(text):
    """Clean extracted text aggressively"""
    if not text:
        return ""
    # Remove all weird whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    text = text.replace('\xa0', ' ')
    text = text.replace('\u00a0', ' ')
    return text


def normalize_db_info(db_info):
    """Normalize database information keys"""
    if not db_info:
        return {}
    
    key_mappings = {
        "database name": "Database Name",
        "db name": "Database Name",
        "name": "Database Name",
        "database version": "Database Version",
        "db version": "Database Version",
        "version": "Database Version",
        "banner": "Database Version",
        "operating system": "Operating System",
        "os": "Operating System",
        "platform": "Operating System",
        "platform_name": "Operating System",
        "cpu numbers": "CPU Numbers",
        "cpu number": "CPU Numbers",
        "cpu_count": "CPU Numbers",
        "num_cpus": "CPU Numbers",
        "cpus": "CPU Numbers",
        "physical memory": "Physical Memory",
        "memory": "Physical Memory",
        "ram": "Physical Memory",
        "total_memory": "Physical Memory",
    }
    
    normalized = {}
    
    for key, value in db_info.items():
        key_lower = key.lower().strip()
        standard_key = key_mappings.get(key_lower, key)
        
        if standard_key not in normalized:
            normalized[standard_key] = value
        else:
            existing_value = str(normalized[standard_key])
            new_value = str(value)
            if len(new_value) > len(existing_value):
                normalized[standard_key] = value
    
    desired_order = [
        "Database Name", "Database Version", "Operating System",
        "CPU Numbers", "Physical Memory"
    ]
    
    ordered = {}
    for key in desired_order:
        if key in normalized:
            ordered[key] = normalized[key]
    
    for key, value in normalized.items():
        if key not in ordered:
            ordered[key] = value
    
    return ordered


def extract_db_info(soup):
    """Extract database information from various formats"""
    db_info = {}
    
    try:
        all_text = soup.get_text()
        
        # System_Configuration_Information section
        if "System_Configuration_Information" in all_text or "SYSTEM_CONFIGURATION_INFORMATION" in all_text:
            lines = all_text.split('\n')
            
            in_config_section = False
            for line in lines:
                line_clean = line.strip()
                
                if "System_Configuration_Information" in line_clean or "SYSTEM_CONFIGURATION_INFORMATION" in line_clean:
                    in_config_section = True
                    continue
                
                if in_config_section and (line_clean.startswith('---') or 
                                          'TABLESPACE' in line_clean.upper() or
                                          line_clean.startswith('=')):
                    if 'TABLESPACE' in line_clean.upper() or line_clean.startswith('='):
                        break
                
                if in_config_section and '::' in line_clean:
                    parts = line_clean.split('::', 1)
                    if len(parts) == 2:
                        key = parts[0].strip()
                        value = parts[1].strip()
                        
                        if "Database Name" in key:
                            db_info["Database Name"] = value
                        elif "Database version" in key or "Database Version" in key:
                            db_info["Database Version"] = value
                        elif "Operating System" in key:
                            db_info["Operating System"] = value
                        elif "CPU numbers" in key or "CPU Numbers" in key:
                            db_info["CPU Numbers"] = value
                        elif "Physical Memory" in key:
                            db_info["Physical Memory"] = value
        
        # Try to extract from paragraphs
        if not db_info:
            paragraphs = soup.find_all(['p', 'pre'])[:20]
            
            for para in paragraphs:
                text = para.get_text()
                
                if re.search(r'Database\s*[Nn]ame', text):
                    match = re.search(r'Database\s*[Nn]ame[:\s]+([^\n\r]+)', text)
                    if match:
                        db_info["Database Name"] = match.group(1).strip()
                
                if re.search(r'Oracle\s+Database', text):
                    match = re.search(r'Oracle\s+Database[^\n]*', text)
                    if match:
                        db_info["Database Version"] = match.group(0).strip()
        
        # Modern format
        db_info_sections = soup.find_all("div", class_="db-info-section")
        for section in db_info_sections:
            items = section.find_all("div", class_="db-info-item")
            for item in items:
                label_div = item.find("div", class_="db-info-label")
                value_div = item.find("div", class_="db-info-value")
                
                if label_div and value_div:
                    label = clean_text(label_div.get_text()).replace('::', '').strip()
                    value = clean_text(value_div.get_text())
                    
                    if label and value:
                        db_info[label] = value
    
    except Exception as e:
        print(f"Error extracting DB info: {str(e)}", file=sys.stderr)
    
    return db_info


def detect_header_row(table):
    """
    Intelligently detect which row contains headers
    Returns (header_row_index, headers_list)
    """
    all_rows = table.find_all('tr')
    
    if not all_rows:
        return None, None
    
    # Strategy 1: Look for <th> tags
    for idx, row in enumerate(all_rows[:3]):  # Check first 3 rows
        th_cells = row.find_all('th')
        if th_cells:
            headers = [clean_text(cell.get_text()) for cell in th_cells]
            if headers and any(h for h in headers):  # At least one non-empty
                return idx, headers
    
    # Strategy 2: First row with bold text or specific styling
    for idx, row in enumerate(all_rows[:3]):
        cells = row.find_all(['td', 'th'])
        if cells:
            # Check if cells have bold styling or are styled differently
            first_cell = cells[0]
            if first_cell.find(['b', 'strong']) or 'font-weight:bold' in str(first_cell.get('style', '')):
                headers = [clean_text(cell.get_text()) for cell in cells]
                if headers and any(h for h in headers):
                    return idx, headers
    
    # Strategy 3: Row with uppercase text (common in SQL*Plus)
    for idx, row in enumerate(all_rows[:3]):
        cells = row.find_all(['td', 'th'])
        if cells:
            texts = [clean_text(cell.get_text()) for cell in cells]
            if texts and all(t.isupper() for t in texts if t):
                return idx, texts
    
    # Strategy 4: Just use first row as headers
    first_row = all_rows[0]
    cells = first_row.find_all(['td', 'th'])
    if cells:
        headers = [clean_text(cell.get_text()) for cell in cells]
        if headers:
            return 0, headers
    
    return None, None


def parse_table_robust(table):
    """
    Ultra-robust table parser
    Returns (headers, rows_data)
    """
    try:
        # Detect header row
        header_idx, headers = detect_header_row(table)
        
        if not headers:
            return None, None
        
        # Clean headers - replace empty with generic names
        headers = [h if h else f"Column_{i+1}" for i, h in enumerate(headers)]
        
        # Get all rows
        all_rows = table.find_all('tr')
        
        # Extract data rows (skip header)
        rows_data = []
        start_idx = (header_idx + 1) if header_idx is not None else 1
        
        for row in all_rows[start_idx:]:
            cells = row.find_all(['td', 'th'])
            
            if not cells:
                continue
            
            # Extract cell data
            row_data = [clean_text(cell.get_text()) for cell in cells]
            
            # Skip if wrong number of columns
            if len(row_data) != len(headers):
                # Try to handle merged cells or missing data
                if len(row_data) < len(headers):
                    row_data.extend([''] * (len(headers) - len(row_data)))
                elif len(row_data) > len(headers):
                    row_data = row_data[:len(headers)]
            
            # Skip if duplicate of headers
            if [r.upper() for r in row_data] == [h.upper() for h in headers]:
                continue
            
            # Skip completely empty rows
            if all(not cell for cell in row_data):
                continue
            
            rows_data.append(row_data)
        
        return headers, rows_data
    
    except Exception as e:
        print(f"Error parsing table: {e}", file=sys.stderr)
        return None, None


def find_section_name_for_table(table, soup):
    """
    Find section name by looking at elements BEFORE the table
    Uses multiple strategies with priority order
    FIXED: Now correctly finds the PRECEDING header, not the following one
    """
    section_name = None
    
    try:
        # Strategy 1: Look backwards through all preceding elements until we hit a header
        # Stop at the first h1/h2/h3 we encounter (going backwards from table)
        for elem in table.find_all_previous():
            # Found a header - this is the section this table belongs to
            if elem.name in ['h1', 'h2', 'h3']:
                text = clean_text(elem.get_text())
                if text and len(text) > 2 and len(text) < 150:
                    section_name = text.upper()
                    return section_name
            
            # Stop if we hit another table - don't go past it
            if elem.name == 'table' and elem != table:
                break
        
        # Strategy 2: Look at immediate previous siblings (if Strategy 1 didn't work)
        if not section_name:
            current = table
            for _ in range(10):  # Look back up to 10 sibling elements
                current = current.find_previous_sibling()
                if current is None:
                    break
                
                if current.name in ['h1', 'h2', 'h3', 'h4', 'h5']:
                    text = clean_text(current.get_text())
                    if text and len(text) > 2 and len(text) < 150:
                        section_name = text.upper()
                        return section_name
                
                if current.name in ['b', 'strong', 'p']:
                    text = clean_text(current.get_text())
                    if text and 3 < len(text) < 100:
                        section_name = text.upper()
        
        # Strategy 3: Look in parent elements
        if not section_name:
            parent = table.find_parent()
            if parent:
                # Look for headers in parent
                for tag_name in ['h1', 'h2', 'h3', 'h4']:
                    header = parent.find(tag_name)
                    if header:
                        text = clean_text(header.get_text())
                        if text and len(text) < 150:
                            section_name = text.upper()
                            return section_name
    
    except Exception as e:
        print(f"Error finding section name: {e}", file=sys.stderr)
    
    return section_name


def match_section_by_columns(headers, section_mapping):
    """
    Match section name based on column headers
    """
    best_match = None
    best_score = 0
    
    for section_name, expected_cols in section_mapping.items():
        match_count = sum(1 for exp_col in expected_cols 
                         if any(exp_col.upper() in h.upper() for h in headers))
        
        score = match_count / len(expected_cols) if expected_cols else 0
        
        if score > best_score and score >= 0.4:  # At least 40% match
            best_score = score
            best_match = section_name
    
    return best_match


def parse_tables_ultra_robust(soup, section_mapping, verbose=True):
    """
    ULTRA-ROBUST table parser - handles ANY HTML format
    """
    results = {}
    parsing_log = []
    
    try:
        tables = soup.find_all("table")
        if verbose:
            print(f"\n🔍 Found {len(tables)} tables in HTML")
            parsing_log.append(f"Found {len(tables)} tables")
        
        for idx, table in enumerate(tables):
            try:
                if verbose:
                    print(f"\n📊 Processing table {idx+1}...")
                
                # Parse table
                headers, rows_data = parse_table_robust(table)
                
                if not headers or not rows_data:
                    if verbose:
                        print(f"   ⚠️ Table {idx+1}: No data extracted")
                    parsing_log.append(f"Table {idx+1}: No data extracted")
                    continue
                
                if verbose:
                    print(f"   ✅ Extracted {len(rows_data)} rows with {len(headers)} columns")
                    print(f"   📝 Columns: {headers[:5]}...")  # Show first 5 columns
                
                # Find section name (PRIORITIZE H1/H2 headers)
                section_name = find_section_name_for_table(table, soup)
                
                # Only use column matching if NO section name found
                if not section_name:
                    section_name = match_section_by_columns(headers, section_mapping)
                    if verbose and section_name:
                        print(f"   🔍 Column-matched to: {section_name}")
                
                # Default name
                if not section_name:
                    section_name = f"SECTION_{idx+1}"
                
                if verbose:
                    print(f"   🏷️ Section name: {section_name}")
                
                parsing_log.append(f"Table {idx+1} → {section_name}: {len(rows_data)} rows")
                
                # Create DataFrame
                df = pd.DataFrame(rows_data, columns=headers)
                df = df.replace('', pd.NA)
                df = df.dropna(how='all')
                df = df.drop_duplicates()
                
                if df.empty:
                    if verbose:
                        print(f"   ⚠️ DataFrame empty after cleanup")
                    parsing_log.append(f"Table {idx+1}: Empty after cleanup")
                    continue
                
                # Avoid duplicate names
                original_name = section_name
                counter = 2
                while section_name in results:
                    section_name = f"{original_name}_{counter}"
                    counter += 1
                
                results[section_name] = df
                if verbose:
                    print(f"   ✅ SUCCESS: {section_name} ({len(df)} rows)")
            
            except Exception as e:
                if verbose:
                    print(f"   ❌ Error processing table {idx+1}: {str(e)}")
                parsing_log.append(f"Table {idx+1}: Error - {str(e)}")
                import traceback
                traceback.print_exc()
                continue
    
    except Exception as e:
        print(f"❌ Critical error: {str(e)}", file=sys.stderr)
        parsing_log.append(f"Critical error: {str(e)}")
        import traceback
        traceback.print_exc()
    
    return results, parsing_log


def standardize_dataframes(results):
    """Standardize numeric columns"""
    numeric_cols_map = {
        "TABLESPACE INFORMATION": ["USED_PERCENT", "FREE_PERCENT", "TOTAL_GB", "USED_GB", "FREE_GB", "USED_PCT", "CURRENT_GB", "MAX_GB"],
        "TABLE FRAGMENTATION": ["WASTAGE_PERCENT", "ACTUAL_SIZE_MB", "RIGHT_SIZE_MB"],
        "INDEX FRAGMENTATION": ["PERCENTAGE", "INDEX_SIZE", "TABLE_SIZE"],
        "AUD$ TABLES": ["SIZE_GB", "SIZE_MB"],
        "TABLES STATS": ["LAST_ANALYZE_DAYS", "LAST_ANALYZED_DAYS", "DAYS_SINCE_ANALYZE"],
        "INDEX STATS": ["LAST_ANALYZE_DAYS", "LAST_ANALYZED_DAYS", "DAYS_SINCE_ANALYZE"],
        "TABLES DEGREE": ["DEGREE"],
        "INDEX DEGREE": ["DEGREE"],
        "TEMP TABLESPACE STATUS": ["TOTAL_MB", "USED_MB", "FREE_MB", "MB_TOTAL", "MB_USED", "MB_FREE"],
    }
    
    for section, df in results.items():
        if df.empty:
            continue
        
        df = df.drop_duplicates()
        
        cols_to_convert = numeric_cols_map.get(section, [])
        
        for target_col in cols_to_convert:
            found_col = None
            
            if target_col in df.columns:
                found_col = target_col
            else:
                for col in df.columns:
                    if col.upper() == target_col.upper():
                        found_col = col
                        break
            
            if found_col:
                df[found_col] = pd.to_numeric(df[found_col], errors='coerce')
        
        if section in ["TABLES DEGREE", "INDEX DEGREE"]:
            degree_col = None
            for col in ["DEGREE", "DEGREE_OF_PARALLELISM", "DOP"]:
                if col in df.columns:
                    degree_col = col
                    break
            
            if degree_col:
                df = df[df[degree_col] > 1]
        
        results[section] = df
    
    return results


def analyze_report(html_content, verbose=False, return_log=False):
    """
    ULTRA-ROBUST HTML analyzer with diagnostics
    ✅ SQL*Plus format
    ✅ Modern format  
    ✅ Any table structure
    ✅ Detailed logging
    
    Args:
        html_content: HTML string to parse
        verbose: If True, print detailed progress (default: False)
        return_log: If True, return parsing log as third value (default: False)
    
    Returns: 
        If return_log=False: (results_dict, db_info_dict)
        If return_log=True: (results_dict, db_info_dict, parsing_log_list)
    """
    try:
        if verbose:
            print("\n" + "="*70)
            print("🚀 STARTING ULTRA-ROBUST HTML ANALYSIS")
            print("="*70)
        
        soup = BeautifulSoup(html_content, "html.parser")
        
        # Extract database info
        db_info_raw = extract_db_info(soup)
        db_info = normalize_db_info(db_info_raw)
        
        if verbose:
            print(f"✅ Database Info: {list(db_info.keys())}")
        
        # Section mapping
        section_mapping = {
            "TABLESPACE INFORMATION": ["TABLESPACE_NAME", "TOTAL_GB", "USED_GB", "FREE_GB", "USED_PCT", "TABLESPACE", "CURRENT_GB", "MAX_GB"],
            "TABLES STATS": ["OWNER", "TABLE_NAME", "STALE_STATS", "LAST_ANALYZED"],
            "INDEX STATS": ["OWNER", "INDEX_NAME", "STALE_STATS", "LAST_ANALYZED", "STALE"],
            "TABLES PARTITION": ["TABLE_OWNER", "TABLE_NAME", "PARTITION_NAME", "PARTITION"],
            "TABLE SIZE AND PARTATION": ["TABLE_OWNER", "TABLE_NAME", "PARTITION_NAME"],
            "TABLE FRAGMENTATION": ["OWNER", "TABLE_NAME", "WASTAGE_PERCENT", "FRAGMENTATION", "ACTUAL_SIZE_MB", "RIGHT_SIZE_MB"],
            "INDEX FRAGMENTATION": ["OWNER", "INDEX_NAME", "PERCENTAGE", "FRAGMENTATION", "TABLE_NAME", "INDEX_SIZE", "TABLE_SIZE"],
            "INVALID OBJECTS": ["INVALID OBJECTS", "OWNER", "OBJECT_TYPE", "OBJECT_NAME", "STATUS"],
            "UNUSED TABLES": ["OWNER", "TABLE_NAME", "TABLESPACE_NAME", "SIZE_MB", "TABLE_OWNER", "TIMESTAMP"],
            "FIXED OBJECT STATS": ["LAST_ANALYZED", "FIXED_OBJECTS"],
            "DATABASE DICTIONARY STATS": ["LAST_ANALYZED", "DICTIONARY_TABLES"],
            "AUD$ TABLES": ["OWNER", "TABLE_NAME", "TABLESPACE_NAME", "SIZE_MB", "AUD$", "SEGMENT_NAME", "SEGMENT_TYPE"],
            "TEMP TABLESPACE STATUS": ["TABLESPACE_NAME", "TOTAL_MB", "USED_MB", "FREE_MB", "TEMP", "TABLESPACE", "MB_TOTAL", "MB_USED", "MB_FREE"],
            "TABLES DEGREE": ["OWNER", "TABLE_NAME", "DEGREE"],
            "INDEX DEGREE": ["OWNER", "INDEX_NAME", "DEGREE"],
            "Oracle Auto-Jobs": ["JOB_NAME", "STATUS", "CLIENT_NAME", "AUTO", "JOB"],
        }
        
        # Parse with ultra-robust parser
        output, parsing_log = parse_tables_ultra_robust(soup, section_mapping, verbose=verbose)
        
        # Standardize
        output = standardize_dataframes(output)
        
        # Final cleanup
        output = {k: v for k, v in output.items() if not v.empty and len(v) > 0}
        
        if verbose:
            print(f"\n" + "="*70)
            print(f"✅ ANALYSIS COMPLETE: {len(output)} sections extracted")
            print("="*70)
            
            for section, df in output.items():
                print(f"   📊 {section}:")
                print(f"      - Rows: {len(df)}")
                print(f"      - Columns: {list(df.columns)[:5]}...")
            
            print("="*70 + "\n")
        
        # Backward compatible: return 2 or 3 values based on return_log parameter
        if return_log:
            return output, db_info, parsing_log
        else:
            return output, db_info
    
    except Exception as e:
        print(f"❌ Critical error: {str(e)}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        
        if return_log:
            return {}, {}, [f"Critical error: {str(e)}"]
        else:
            return {}, {}