import re

# Read the file
with open('app/api/endpoints/chat.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace the buggy search.ismatch syntax
# Fix: Use double quotes for f-string, single quotes inside for OData
pattern = r'search\.ismatch\(\'([^\']+)\', \'source\'\)'
replacement = r'search.ismatch(\'\1\', \'source\')'  # Keep as-is, just fix f-string quotes

# Manual replacement of the problematic lines
old_pattern = r"doc_search_parts\.append\(f'search\.ismatch\('([^']+)', 'source'\)'\)"
new_pattern = r'doc_search_parts.append(f"search.ismatch(\'\1\', \'source\')")'

content = re.sub(old_pattern, new_pattern, content)

# Also fix the alternative patterns
content = content.replace(
    "doc_search_parts.append(f'search.ismatch('{safe_doc_id}', 'source')')",
    'doc_search_parts.append(f"search.ismatch(\'{safe_doc_id}\', \'source\')")'
)
content = content.replace(
    "doc_search_parts.append(f'search.ismatch('{safe_doc_id}.pdf', 'source')')",
    'doc_search_parts.append(f"search.ismatch(\'{safe_doc_id}.pdf\', \'source\')")'
)
content = content.replace(
    "doc_search_parts.append(f'search.ismatch('{safe_doc_id}.pdf.pdf', 'source')')",
    'doc_search_parts.append(f"search.ismatch(\'{safe_doc_id}.pdf.pdf\', \'source\')")'
)

# Write back
with open('app/api/endpoints/chat.py', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Fixed f-string quote conflict!")
