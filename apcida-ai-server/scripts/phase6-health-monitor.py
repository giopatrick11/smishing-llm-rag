#!/usr/bin/env python3
"""Local, credential-free health checks for the supervised Mac beta server.

The Cloudflare Access redirect proves the edge answers, not that an authenticated
request reaches the origin. Tunnel process state and recent connector log events
are separate signals; no SMS, identifiers, or log lines enter monitor state.
"""

import argparse
import fcntl
import json
import os
import re
import stat
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_ROOT = Path.home() / "Library/Application Support/ApCiDa/controlled-server"
STATE_NAME = "health-monitor-state.json"
TUNNEL_LOG = "cloudflared.error.log"
LOG_PATTERN = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:INF|WRN|ERR)\b")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def utc_now():
    return datetime.now(timezone.utc)


def private_root(root):
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Monitor directory must be owner-only")


def http_status(url, timeout=8):
    try:
        request = Request(url, headers={"User-Agent": "ApCiDa-health-monitor/1.0"})
        with build_opener(NoRedirect).open(request, timeout=timeout) as response:
            return response.status
    except HTTPError as error:
        return error.code
    except (URLError, TimeoutError, OSError):
        return None


def command_ok(args, timeout=5):
    try:
        return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=timeout, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def tunnel_running():
    try:
        result = subprocess.run(
            ["/bin/launchctl", "print", f"gui/{os.getuid()}/com.apcida.cloudflared"],
            capture_output=True, text=True, timeout=5, check=False)
        return result.returncode == 0 and re.search(r"(?m)^\s*state = running$", result.stdout) is not None
    except (OSError, subprocess.TimeoutExpired):
        return False


def tunnel_events(path, now):
    """Count recent connection changes without returning or retaining log content."""
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                return 0, 0, None
            os.lseek(fd, max(0, info.st_size - 262144), os.SEEK_SET)
            data = os.read(fd, 262144)
        finally:
            os.close(fd)
    except OSError:
        return 0, 0, None
    if len(data) == 262144:
        data = data.split(b"\n", 1)[-1]
    terminated = registered = 0
    latest_termination = None
    for line in data.splitlines():
        if len(line) > 2048:
            continue
        value = line.decode("utf-8", errors="replace")
        match = LOG_PATTERN.match(value)
        if not match:
            continue
        try:
            when = datetime.fromisoformat(match.group(1).replace("Z", "+00:00"))
        except ValueError:
            continue
        if not now - timedelta(seconds=130) <= when <= now + timedelta(seconds=10):
            continue
        lower = value.lower()
        if "connection terminated" in lower:
            terminated += 1
            if latest_termination is None or when > latest_termination:
                latest_termination = when
        elif "registered tunnel connection" in lower:
            registered += 1
    return terminated, registered, latest_termination.strftime("%Y-%m-%dT%H:%M") if latest_termination else None


def checks(root, now):
    pg_bin = "/opt/homebrew/opt/postgresql@17/bin/pg_isready"
    statuses = {
        "api": http_status("http://127.0.0.1:3021/health", timeout=4) == 200,
        "database": command_ok([pg_bin, "-q", "-h", "127.0.0.1", "-p", "55436"]),
        "tunnel_process": tunnel_running(),
        "cloudflare_edge": http_status("https://sms.apcida.stream/health") == 302,
    }
    terminated, registered, flap_key = tunnel_events(root / TUNNEL_LOG, now)
    return statuses, terminated, registered, flap_key


def read_state(path):
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 16384:
                return {}
            return json.loads(os.read(fd, 16384))
        finally:
            os.close(fd)
    except (OSError, ValueError, json.JSONDecodeError):
        return {}


def write_state(path, state):
    fd, temporary = tempfile.mkstemp(prefix=".health-monitor-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(state, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def notify(message):
    # Fixed text only. Notifications never contain a hostname, SMS, or credential.
    script = f'display notification "{message}" with title "ApCiDa server monitor"'
    command_ok(["/usr/bin/osascript", "-e", script], timeout=5)


def run(root, no_notify=False, verbose=False):
    private_root(root)
    lock_path = root / "health-monitor.lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.fchmod(lock_fd, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        now = utc_now()
        previous = read_state(root / STATE_NAME)
        statuses, terminated, registered, flap_key = checks(root, now)
        healthy = all(statuses.values())
        recent_flap = terminated >= 3
        events = previous.get("events", []) if isinstance(previous.get("events"), list) else []
        alert = None
        if previous.get("healthy") is True and not healthy:
            alert = "API, database, or tunnel needs attention."
            events.append({"at": now.isoformat(), "kind": "unavailable"})
        elif previous.get("healthy") is False and healthy:
            alert = "API and tunnel checks recovered."
            events.append({"at": now.isoformat(), "kind": "recovered"})
        elif not previous and not healthy:
            alert = "API, database, or tunnel needs attention."
            events.append({"at": now.isoformat(), "kind": "unavailable"})
        if recent_flap and previous.get("last_flap_key") != flap_key:
            alert = "Tunnel connections restarted; check recent pilot messages."
            events.append({"at": now.isoformat(), "kind": "tunnel_flap",
                           "terminated": min(terminated, 99), "registered": min(registered, 99)})
        state = {"checked_at": now.isoformat(), "healthy": healthy, "checks": statuses,
                 "last_flap_key": flap_key or previous.get("last_flap_key"),
                 "events": events[-50:]}
        write_state(root / STATE_NAME, state)
        if alert and not no_notify:
            notify(alert)
        if verbose:
            print(json.dumps({"healthy": healthy, "checks": statuses,
                              "recent_tunnel_terminations": terminated,
                              "recent_tunnel_registrations": registered,
                              "alert": alert}, sort_keys=True))
        return healthy
    finally:
        os.close(lock_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--once", action="store_true", help="Print one check result")
    parser.add_argument("--status", action="store_true", help="Print last stored check and events")
    parser.add_argument("--no-notify", action="store_true", help="Suppress desktop notifications")
    args = parser.parse_args()
    if args.status:
        private_root(args.root)
        state = read_state(args.root / STATE_NAME)
        print(json.dumps(state, sort_keys=True))
        return
    healthy = run(args.root, no_notify=args.no_notify, verbose=args.once)
    if args.once and not healthy:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
