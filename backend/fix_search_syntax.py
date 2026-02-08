import re

# Read the file
with open('app/api/endpoints/chat.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace the buggy search.ismatch syntax
# From: search.ismatch("\"filename\"", "source")
# To: search.ismatch('filename', 'source')

pattern = r'search\.ismatch\(\"\\\"([^\"]+)\\\"\", \"source\"\)'
replacement = r"search.ismatch('\1', 'source')"

new_content = re.sub(pattern, replacement, content)

# Write back
with open('app/api/endpoints/chat.py', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Fixed search.ismatch() syntax!")
