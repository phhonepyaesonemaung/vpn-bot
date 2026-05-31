#!/usr/bin/env python3
"""
Status checker for the vpn-bot server.

Run on the Ubuntu server from the project directory:
  python3 check_server_status.py

Optional:
  python3 check_server_status.py --restart
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
ENV_FILE = PROJECT_ROOT / ".env"
PM2_APPS = ("vpn-bot", "vpn-dashboard")
TIMEOUT_SECONDS = 8


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")

    return env


def run_command(command: list[str]) -> tuple[int, str, str]:
    try:
        result = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            text=True,
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
        return result.returncode, result.stdout.strip(), result.stderr.strip()
    except FileNotFoundError:
        return 127, "", f"{command[0]} not found"
    except subprocess.TimeoutExpired:
        return 124, "", "command timed out"


def check_pm2(restart: bool) -> tuple[bool, list[str]]:
    code, stdout, stderr = run_command(["pm2", "jlist"])
    if code != 0:
        return False, [f"pm2 unavailable: {stderr or stdout or 'unknown error'}"]

    try:
        processes = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return False, [f"pm2 returned invalid JSON: {exc}"]

    by_name = {proc.get("name"): proc for proc in processes}
    ok = True
    lines: list[str] = []

    for app in PM2_APPS:
        proc = by_name.get(app)
        if not proc:
            ok = False
            lines.append(f"{app}: missing from pm2")
            continue

        env = proc.get("pm2_env", {})
        status = env.get("status", "unknown")
        restarts = env.get("restart_time", 0)
        memory_mb = int(proc.get("monit", {}).get("memory", 0)) / 1024 / 1024
        lines.append(f"{app}: {status}, restarts={restarts}, memory={memory_mb:.1f} MB")

        if status != "online":
            ok = False
            if restart:
                run_command(["pm2", "restart", app])
                lines.append(f"{app}: restart requested")

    return ok, lines


def http_get(url: str, headers: dict[str, str] | None = None) -> tuple[bool, str]:
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.status < 500, f"HTTP {response.status}"
    except urllib.error.HTTPError as exc:
        # 401 on the dashboard still means the web server is reachable.
        if exc.code == 401:
            return True, "HTTP 401 auth required"
        return False, f"HTTP {exc.code}"
    except Exception as exc:
        return False, str(exc)


def check_dashboard(env: dict[str, str]) -> tuple[bool, str]:
    port = env.get("DASHBOARD_PORT") or env.get("PORT") or "3000"
    url = f"http://127.0.0.1:{port}/"
    headers: dict[str, str] = {}

    password = env.get("DASHBOARD_PASSWORD")
    if password:
        token = base64.b64encode(f"status:{password}".encode("utf-8")).decode("ascii")
        headers["Authorization"] = f"Basic {token}"

    ok, message = http_get(url, headers)
    return ok, f"{url}: {message}"


def tcp_check(host: str, port: int) -> tuple[bool, str]:
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT_SECONDS):
            return True, f"{host}:{port} reachable"
    except Exception as exc:
        return False, f"{host}:{port} unreachable: {exc}"


def check_mongo(env: dict[str, str]) -> tuple[bool, str]:
    mongo_uri = env.get("MONGO_URI")
    if not mongo_uri:
        return False, "MONGO_URI missing"

    parsed = urllib.parse.urlparse(mongo_uri)
    host = parsed.hostname
    port = parsed.port or 27017
    if not host:
        return False, "MONGO_URI host missing"

    return tcp_check(host, port)


def check_telegram(env: dict[str, str]) -> tuple[bool, str]:
    token = env.get("BOT_TOKEN")
    if not token:
        return False, "BOT_TOKEN missing"

    url = f"https://api.telegram.org/bot{token}/getMe"
    ok, message = http_get(url)
    if ok:
        return True, "api.telegram.org reachable"
    return False, f"api.telegram.org failed: {message}"


def print_result(name: str, ok: bool, detail: str | list[str]) -> None:
    marker = "OK" if ok else "FAIL"
    print(f"[{marker}] {name}")
    if isinstance(detail, list):
        for line in detail:
            print(f"  - {line}")
    else:
        print(f"  - {detail}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check vpn-bot server status.")
    parser.add_argument(
        "--restart",
        action="store_true",
        help="restart pm2 apps that are not online",
    )
    args = parser.parse_args()

    env = {**os.environ, **load_env(ENV_FILE)}
    checks = [
        ("PM2", *check_pm2(args.restart)),
        ("Dashboard", *check_dashboard(env)),
        ("MongoDB TCP", *check_mongo(env)),
        ("Telegram API", *check_telegram(env)),
    ]

    all_ok = True
    for name, ok, detail in checks:
        print_result(name, ok, detail)
        all_ok = all_ok and ok

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
