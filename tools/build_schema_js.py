"""Regenerate lib/schema.js from schema.sql.

The site embeds the schema as a JavaScript string so it also works when
index.html is opened straight from disk (browsers block fetch() of local
files). Run this after editing schema.sql:

    python tools/build_schema_js.py
"""
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
sql = (root / "schema.sql").read_text(encoding="utf-8")
out = root / "lib" / "schema.js"
out.write_text(
    "// Generated from schema.sql by tools/build_schema_js.py. Edit schema.sql, then rerun the script.\n"
    f"window.NMRDB_SCHEMA = {json.dumps(sql, ensure_ascii=False)};\n",
    encoding="utf-8",
)
print(f"wrote {out.relative_to(root)} ({len(sql)} characters of SQL)")
