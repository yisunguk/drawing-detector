#!/usr/bin/env python3
# Script to add Python-side doc_ids filtering to chat.py

with open('app/api/endpoints/chat.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the line with "Raw Search Results Count"
insert_after_line = None
for i, line in enumerate(lines):
    if 'Raw Search Results Count' in line:
        insert_after_line = i
        break

if insert_after_line is None:
    print("ERROR: Could not find insertion point")
    exit(1)

# Insert filtering logic after this line
filtering_code = '''            
            # NEW: Python-side filtering by doc_ids (avoids Azure OData Korean issues)
            if request.doc_ids and len(request.doc_ids) > 0:
                print(f"[Chat] Filtering results by doc_ids: {request.doc_ids}")
                filtered_results = []
                for result in results_list:
                    source_filename = result.get('source', '')
                    # Check if source matches any doc_id (handle .pdf and .pdf.pdf variants)
                    for doc_id in request.doc_ids:
                        # Match: exact, with .pdf, or with .pdf.pdf
                        if (source_filename == doc_id or 
                            source_filename == f"{doc_id}.pdf" or 
                            source_filename == f"{doc_id}.pdf.pdf" or
                            source_filename == doc_id.replace('.pdf', '') or
                            source_filename == f"{doc_id.replace('.pdf', '')}.pdf.pdf"):
                            filtered_results.append(result)
                            break
                results_list = filtered_results
                print(f"[Chat] Filtered Results Count: {len(results_list)}")
'''

# Insert the code
lines.insert(insert_after_line + 1, filtering_code)

# Write back
with open('app/api/endpoints/chat.py', 'w', encoding='utf-8') as f:
    f.writelines(lines)

print(f"✅ Inserted filtering logic after line {insert_after_line + 1}")
