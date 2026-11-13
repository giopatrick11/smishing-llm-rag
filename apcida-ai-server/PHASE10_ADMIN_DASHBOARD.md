# ApCiDa administrator dashboard

The dashboard runs on the Mac at `http://127.0.0.1:3022`. It is separate from the phone API on port 3021. Its Mac login service is `com.apcida.admin-dashboard`.

## What the administrator can do

1. Open **Reports**. The inbox shows report IDs and status, not SMS text. Open a report to view its decrypted content.
2. **Mark reviewed without RAG** or **Dismiss** if the report does not warrant a knowledge example.
3. For a report with combined review and RAG consent, remove personal information from the example text, independently choose SCAM or SAFE, and stage it. The app's verdict is an observation, not the verified label.
4. Open **RAG candidates**. Check the staged text, label, source, reviewer, and validation results. Type the exact confirmation shown to approve. Approval inserts the example into live RAG immediately; the dashboard opens its approved example page. No separate import or service restart is needed.
5. Open **Approved examples** to inspect active examples. Type the deactivation confirmation to stop an example being retrieved in future analyses while retaining its audit record.
6. Open **Invites & devices** to create a one-use invite for a phone. Copy the code from the creation page immediately and send it privately to that phone's owner. The dashboard stores only its hash, so it cannot show the code again. The invite is available for 24 hours unless used or canceled first.
7. The same page shows each recent invite as **Available**, **Being redeemed**, **Used**, **Expired**, or **Canceled**. Cancel an unused invite there if it should no longer work.
8. The **Phones** table shows enrolled phones and backend access status. To stop one phone, type the exact `REVOKE` confirmation shown beside it. Revocation blocks its backend credential immediately and deletes that phone's stored reports and cached analyses. The dashboard then removes its Cloudflare service token; if Cloudflare is unavailable, the page offers a cleanup retry. A revoked phone needs a new invite to use the service again.

There is no automatic promotion of a report into RAG. A report expires after 30 days under the existing report retention process. The dashboard refuses to stage an expired report.

## Local access

Open `http://127.0.0.1:3022/login` on the Mac. The private dashboard password is stored at `~/Library/Application Support/ApCiDa/controlled-server/dashboard-login.key` (mode 0600). Do not send it to a phone or put it in Git. The dashboard database role is `apcida_review` and has limited permissions for report and RAG review, invite creation and cancellation, and phone revocation. The invite list never displays previously issued codes or phone credentials.

Local service checks:

```sh
curl -fsS http://127.0.0.1:3022/health
launchctl print "gui/$(id -u)/com.apcida.admin-dashboard"
```

To copy the administrator password without displaying it in Terminal, run:

```sh
pbcopy < "$HOME/Library/Application Support/ApCiDa/controlled-server/dashboard-login.key"
```

The command has no output. Paste into the dashboard's **Administrator password** field, then clear the clipboard when finished. Never send the password in chat or a screenshot.

## Publish through Cloudflare after Access is configured

1. In **Zero Trust → Access controls → Applications**, create a **Self-hosted and private** application named `ApCiDa admin`. Set its public hostname to `admin.apcida.stream` with the **Path blank**. Attach an **Allow** policy limited to your own verified email address. Do not use **Everyone**, **Bypass**, or a phone service-token policy. Save the application.
2. In **Networking → Tunnels → apcida-pilot → Routes**, add a **Published application** route. Hostname: `admin.apcida.stream`; Path: blank; Service URL: `http://127.0.0.1:3022`. Save it. Leave the existing `sms.apcida.stream` phone route as it is.
3. In a private browser window, check that `https://admin.apcida.stream/login` asks for Cloudflare Access authentication. At this stage the dashboard itself returns 403 after authentication because its public gate is still closed.
4. Once Access is confirmed, set `ADMIN_DASHBOARD_PUBLIC_ENABLED=true` in the private `production.env` and restart `com.apcida.admin-dashboard`. Sign in with the dashboard password and check the Reports page. An unauthorized account must still be denied by Access.

The dashboard defaults to **local-only** even when a tunnel route exists. Its public hostname remains closed until the owner has verified the Access gate and sets `ADMIN_DASHBOARD_PUBLIC_ENABLED=true` in the private `production.env`, then restarts `com.apcida.admin-dashboard`. This prevents a route mistake from exposing the login page.

Do not publish the route before the Access application is saved. Cloudflare says a published application route otherwise makes the hostname reachable to anyone on the Internet. The dashboard password adds a second check, but Cloudflare Access should be the outer gate.

The dashboard binds to `127.0.0.1` only. This remains a Mac-hosted beta: if the Mac is off, asleep, signed out, or disconnected, the admin website and phone service are unavailable.
