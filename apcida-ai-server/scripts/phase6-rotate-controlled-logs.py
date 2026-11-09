#!/usr/bin/env python3
"""Keep local controlled-server diagnostics private and bounded in age.

LaunchAgents keep their log files open, so copy each file before truncating the
same inode. A line written during that brief interval can be lost; these logs
are diagnostics and must not be used as an authoritative request ledger.
"""

import argparse
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path


LOG_NAMES = (
    "server.log",
    "server.error.log",
    "cloudflared.log",
    "cloudflared.error.log",
    "admin-dashboard.log",
    "admin-dashboard.error.log",
)
DEFAULT_ROOT = Path.home() / "Library/Application Support/ApCiDa/controlled-server"
RETENTION_DAYS = 30


def require_private_dir(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError(f"Refusing unsafe log directory: {path}")
    os.chmod(path, 0o700)


def rotate_one(path: Path, archive_dir: Path, timestamp: str) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    source = os.open(path, flags)
    try:
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError(f"Refusing unsafe log file: {path}")
        os.fchmod(source, 0o600)
        if info.st_size == 0:
            return
        destination = archive_dir / f"{path.name}.{timestamp}"
        output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            remaining = info.st_size
            while remaining:
                chunk = os.read(source, min(65536, remaining))
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    view = view[os.write(output, view):]
                remaining -= len(chunk)
            os.fsync(output)
        finally:
            os.close(output)
    finally:
        os.close(source)

    # The writer can append between the copy and truncate. Keep the inode open
    # and truncate only after the archive has been safely written.
    writable = os.open(path, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        current = os.fstat(writable)
        if not stat.S_ISREG(current.st_mode) or current.st_uid != os.getuid() or current.st_ino != info.st_ino:
            raise ValueError(f"Log file changed during rotation: {path}")
        os.ftruncate(writable, 0)
    finally:
        os.close(writable)


def prune_old(archive_dir: Path, now: datetime) -> None:
    cutoff = (now - timedelta(days=RETENTION_DAYS)).timestamp()
    for name in LOG_NAMES:
        for path in archive_dir.glob(f"{name}.*"):
            info = path.lstat()
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_mtime < cutoff:
                path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    os.umask(0o077)
    require_private_dir(args.root)
    archive_dir = args.root / "log-archive"
    archive_dir.mkdir(mode=0o700, exist_ok=True)
    require_private_dir(archive_dir)
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y%m%dT%H%M%S%fZ")
    for name in LOG_NAMES:
        path = args.root / name
        if path.exists() or path.is_symlink():
            rotate_one(path, archive_dir, timestamp)
    prune_old(archive_dir, now)


if __name__ == "__main__":
    main()
