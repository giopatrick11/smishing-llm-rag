# Mac health monitor for the supervised beta

The monitor checks every 60 seconds after Mac login. It checks the local API at `127.0.0.1:3021/health`, local PostgreSQL readiness, the Cloudflare Tunnel LaunchAgent, and whether Cloudflare Access answers at `sms.apcida.stream/health`. It also counts recent tunnel connection terminations and registrations in the private connector log. It stores only check results, event types, counts, and times in an owner-only state file. It does not store SMS content, senders, invites, or credentials.

Install or update it from `apcida-ai-server`:

```sh
bash scripts/phase6-install-health-monitor.sh
```

Read its latest status:

```sh
/usr/bin/python3 "$HOME/Library/Application Support/ApCiDa/controlled-server/bin/health-monitor.py" --status
```

For a fresh check that prints only health results:

```sh
/usr/bin/python3 "$HOME/Library/Application Support/ApCiDa/controlled-server/bin/health-monitor.py" --once --no-notify
```

It raises a local macOS notification when a check changes from healthy to unavailable or back, or when several tunnel connections restart together. macOS notification settings can suppress the visible notification; the private status file still records the event. The monitor runs only while this Mac is on and logged in. A Cloudflare Access redirect proves the edge responds, not that an authenticated phone request reached the API. A brief outage between checks may be missed. Continue using the phone's `AI UNAVAILABLE` result as unverified when an analysis does not complete.

To stop just this monitor:

```sh
launchctl bootout "gui/$(id -u)/com.apcida.health-monitor"
```
