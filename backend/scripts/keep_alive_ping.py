#!/usr/bin/env python3
"""Simple keep-alive ping worker for Railway/Render style cold-start reduction.

Usage:
  BACKEND_WARMUP_URL=https://your-app.up.railway.app/warmup python backend/scripts/keep_alive_ping.py
"""

import os
import random
import time
import urllib.error
import urllib.request


WARMUP_URL = str(os.getenv("BACKEND_WARMUP_URL", "")).strip()
INTERVAL_SECONDS = max(60, int(os.getenv("BACKEND_WARMUP_INTERVAL_SECONDS", "240")))
TIMEOUT_SECONDS = max(2, int(os.getenv("BACKEND_WARMUP_TIMEOUT_SECONDS", "8")))


if not WARMUP_URL:
    raise SystemExit("Set BACKEND_WARMUP_URL to your /warmup endpoint URL")

print(f"[keepalive] Starting warmup pings to {WARMUP_URL} every {INTERVAL_SECONDS}s")

while True:
    started = time.perf_counter()
    try:
        req = urllib.request.Request(WARMUP_URL, method="GET")
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            body = resp.read(200).decode("utf-8", errors="ignore")
            elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
            print(f"[keepalive] {resp.status} in {elapsed_ms}ms :: {body}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
        print(f"[keepalive] failed in {elapsed_ms}ms :: {exc}")

    # Add small jitter so distributed workers don't synchronize.
    sleep_for = INTERVAL_SECONDS + random.randint(-15, 15)
    time.sleep(max(45, sleep_for))
