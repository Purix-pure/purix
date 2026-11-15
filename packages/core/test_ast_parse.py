import ast
import json
import sys

code = "assert 1 == 1"
try:
    tree = ast.parse(code)
    print(json.dumps({"success": True}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
