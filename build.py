#!/usr/bin/env python3
"""Assemble index.html (for the claude.ai artifact) and public/index.html (standalone) from src/app.js + data.js."""
import json, re, pathlib
root = pathlib.Path(__file__).parent
src = (root/'src/app.js').read_text(encoding='utf-8')
data_js = (root/'data.js').read_text(encoding='utf-8')
pages = json.loads(data_js[data_js.index('{'):data_js.rindex('}')+1])
meta_path = root/'meta.json'
meta = json.loads(meta_path.read_text(encoding='utf-8')) if meta_path.exists() else {}
state = json.dumps({'pages': pages, 'meta': meta}, ensure_ascii=False, separators=(',',':')).replace('<','\\u003c')
head = ('<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        "<title>מאתר צ' נשק</title>\n"
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;900&family=IBM+Plex+Mono:wght@500;700&display=swap">')
data_tag = f'<script id="pages-data" type="application/json">{state}</script>'
app_tag = f'<script id="app">{src}</script>'
# artifact version: no doctype/html/head/body (the publish step wraps it)
(root/'index.html').write_text(f"<title>מאתר צ' נשק</title>\n{head.split(chr(10),2)[0]}\n{head.split(chr(10),2)[1]}\n{head.splitlines()[3]}\n{data_tag}\n{app_tag}\n", encoding='utf-8')
# standalone version: full document, same shape the page itself republishes
(root/'public').mkdir(exist_ok=True)
(root/'public/index.html').write_text(f'<!doctype html>\n<html lang="he" dir="rtl">\n<head>\n{head}\n{data_tag}\n</head>\n<body>\n{app_tag}\n</body>\n</html>\n', encoding='utf-8')
n = sum(len(v) for v in pages.values())
print(f'built: {len(pages)} pages, {n} serials, index.html {len((root/"index.html").read_bytes())} bytes')
