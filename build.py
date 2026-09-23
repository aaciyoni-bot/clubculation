#!/usr/bin/env python3
"""Assemble index.html (for the claude.ai artifact) and public/index.html (standalone) from src/app.js + data.js."""
import json, re, pathlib
root = pathlib.Path(__file__).parent
src = (root/'src/model.js').read_text(encoding='utf-8') + '\n' + (root/'src/app.js').read_text(encoding='utf-8')
# The live list lives in the shared store (server) or in the page itself (claude.ai). The page ships empty.
# data.js keeps the retired 2026-09-17 transcription (21 pages) as an archive.
state = json.dumps({'v': 2, 'series': {}, 'pages': {}, 'meta': {}}, separators=(',',':'))
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
print(f'built: index.html {len((root/"index.html").read_bytes())} bytes')
