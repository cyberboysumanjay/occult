#!/usr/bin/env python3
"""Tiny static server for occult.

Web Bluetooth requires a secure context — http://localhost counts, file:// does
not. This just serves the current directory so you can open it in Chrome/Edge.

    python serve.py [port]      # default 8765
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
handler = partial(SimpleHTTPRequestHandler)
# Ensure ES modules / manifest are served with sane content types.
SimpleHTTPRequestHandler.extensions_map.update({
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".webmanifest": "application/manifest+json",
})

print(f"occult -> http://localhost:{port}  (Ctrl+C to stop)")
print("Open in Chrome/Edge, then Connect scale.")
try:
    ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()
except KeyboardInterrupt:
    print("\nstopped")
