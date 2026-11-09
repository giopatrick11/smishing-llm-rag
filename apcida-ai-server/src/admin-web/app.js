const express = require('express');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { signature } = require('../knowledge/dedupe');
const { validateImport, stageImport, embedPending, listPending,
  countActive, listActive, showActive } = require('../knowledge/adminRepository');
const { getReviewEntry, approveBatch } = require('../knowledge/batchReview');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID = /^[1-9]\d{0,14}$/u;
const COOKIE = 'apcida_admin_session';
const SESSION_MS = 4 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function date(value) {
  return value instanceof Date ? value.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
}

function validReportIds(installationId, reportId) {
  return UUID.test(installationId) && UUID.test(reportId);
}

function constantTimePassword(supplied, expected) {
  const a = createHash('sha256').update(String(supplied || '')).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function page({ title, body, csrf = '', notice = '', active = '' }) {
  const nav = csrf ? `<nav><a class="brand" href="/reports">ApCiDa <span>Review</span></a>
    <div class="navlinks"><a class="${active === 'reports' ? 'selected' : ''}" href="/reports">Reports</a>
    <a class="${active === 'staged' ? 'selected' : ''}" href="/staged">RAG candidates</a>
    <a class="${active === 'active' ? 'selected' : ''}" href="/knowledge">Approved examples</a>
    <a class="${active === 'devices' ? 'selected' : ''}" href="/devices">Invites &amp; devices</a>
    <form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="textbutton">Sign out</button></form></div></nav>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)} · ApCiDa Review</title><link rel="stylesheet" href="/admin.css"></head><body>${nav}
    <main class="container">${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}${body}</main>
    <footer>Private administrator workspace · Reports and RAG examples are separate records</footer></body></html>`;
}

function header(eyebrow, title, description) {
  return `<header class="pagehead"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></header>`;
}

function badge(status) {
  const style = /^(PENDING|PENDING_EMBEDDING|PENDING_APPROVAL)$/u.test(status) ? 'pending'
    : /^(REVIEWED|APPROVED|ACTIVE|AVAILABLE)$/u.test(status) ? 'good' : 'muted';
  return `<span class="badge ${style}">${escapeHtml(status.replaceAll('_', ' '))}</span>`;
}

function errorPage(res, csrf, message, status = 400) {
  res.status(status).send(page({ title: 'Action unavailable', csrf,
    body: `${header('Review workspace', 'Action unavailable', message)}<p><a href="/reports">Back to reports</a></p>` }));
}

function createAdminApp({ pool, codec, loginPassword, embeddingService, corpus,
  publicHost = 'admin.apcida.stream', localPort = 3022, publicEnabled = false,
  deviceManagement = null }) {
  if (!pool || !codec?.decryptReport || !embeddingService?.embed || !corpus?.sha256 ||
    typeof loginPassword !== 'string' || loginPassword.length < 32) {
    throw new Error('Admin dashboard configuration is incomplete');
  }
  const app = express();
  const sessions = new Map();
  const loginAttempts = [];
  const localHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
  const allowedHosts = new Set([...localHosts, publicHost]);
  const allowedOrigins = new Set([`http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`,
    `https://${publicHost}`]);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store, private', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    if (!allowedHosts.has(req.headers.host)) return res.status(421).end();
    if (req.headers.host === publicHost && !publicEnabled) return res.status(403).end();
    if (req.headers.host === publicHost && req.headers['x-forwarded-proto'] !== 'https') {
      return res.status(403).end();
    }
    next();
  });
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/admin.css', (req, res) => res.sendFile(require('node:path').join(__dirname, 'admin.css')));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const publicOpaqueOrigin = req.headers.host === publicHost && publicEnabled &&
      req.headers['x-forwarded-proto'] === 'https' && origin === 'null';
    // Some browsers send an opaque Origin through Access. Authenticated actions
    // still require the private session cookie and their unpredictable CSRF token.
    if (req.method === 'POST' && !allowedOrigins.has(origin) && !publicOpaqueOrigin) {
      return res.status(403).end();
    }
    next();
  });
  function currentSession(req) {
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`));
    const token = cookie?.slice(COOKIE.length + 1);
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expires <= Date.now()) { sessions.delete(token); return null; }
    return session;
  }
  app.get('/login', (req, res) => {
    if (currentSession(req)) return res.redirect('/reports');
    res.send(page({ title: 'Sign in', body: `${header('Private dashboard', 'Review reports securely',
      'Sign in with the administrator password stored on your Mac.')}
      <form class="card login" method="post" action="/login"><label for="password">Administrator password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password" autofocus>
      <button class="primary">Sign in</button></form>` }));
  });
  app.post('/login', (req, res) => {
    const now = Date.now();
    while (loginAttempts.length && loginAttempts[0] < now - LOGIN_WINDOW_MS) loginAttempts.shift();
    if (loginAttempts.length >= MAX_LOGIN_ATTEMPTS) return res.status(429).send('Too many attempts. Try again later.');
    if (!constantTimePassword(req.body.password, loginPassword)) {
      loginAttempts.push(now);
      return res.status(401).send(page({ title: 'Sign in', body: `${header('Private dashboard', 'Sign in failed',
        'Check the administrator password and try again.')}<p><a href="/login">Return to sign in</a></p>` }));
    }
    loginAttempts.length = 0;
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { csrf: randomBytes(32).toString('hex'), expires: now + SESSION_MS });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.headers.host === publicHost,
      maxAge: SESSION_MS, path: '/' });
    res.redirect(303, '/reports');
  });
  app.use((req, res, next) => {
    const session = currentSession(req);
    if (!session) return res.redirect(303, '/login');
    req.adminSession = session;
    if (req.method === 'POST' && req.body.csrf !== session.csrf) return res.status(403).end();
    next();
  });
  app.post('/logout', (req, res) => {
    const cookie = req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`));
    if (cookie) sessions.delete(cookie.slice(COOKIE.length + 1));
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });
  app.get('/', (req, res) => res.redirect('/reports'));
  if (deviceManagement) {
    app.get('/devices', async (req, res) => {
      const [invites, devices] = await Promise.all([
        deviceManagement.listInvites(), deviceManagement.listDevices(),
      ]);
      const now = Date.now();
      const inviteRows = invites.map((invite) => {
        const status = invite.canceled_at ? 'CANCELED' : invite.used_at ? 'USED'
          : new Date(invite.expires_at).getTime() <= now ? 'EXPIRED'
            : invite.claim_until && new Date(invite.claim_until).getTime() > now
              ? 'BEING REDEEMED' : 'AVAILABLE';
        const cancel = status === 'AVAILABLE' ? `<form method="post" action="/invites/${invite.invite_hash}/cancel">
          <input type="hidden" name="csrf" value="${req.adminSession.csrf}">
          <button class="textbutton" aria-label="Cancel invite ${escapeHtml(invite.label)}">Cancel</button></form>` : '';
        return `<tr><td>${escapeHtml(invite.label)}</td><td>${badge(status)}</td>
          <td>${date(invite.expires_at)}</td><td>${invite.used_at ? date(invite.used_at) : '—'}</td>
          <td>${cancel}</td></tr>`;
      }).join('');
      const deviceRows = devices.map((device) => {
        const status = device.revoked_at ? 'REVOKED'
          : new Date(device.expires_at).getTime() <= now ? 'EXPIRED' : 'ACTIVE';
        const pending = device.revoked_at && device.cf_service_token_id
          ? ' · Cloudflare cleanup pending' : '';
        const button = status === 'ACTIVE' ? `<form method="post" action="/devices/${device.installation_id}/revoke">
          <input type="hidden" name="csrf" value="${req.adminSession.csrf}">
          <input name="confirmation" aria-label="Confirm revoke ${escapeHtml(device.label)}" placeholder="Type REVOKE ${device.installation_id}" required autocomplete="off">
          <button class="danger">Revoke access</button></form>`
          : device.cf_service_token_id ? `<form method="post" action="/devices/${device.installation_id}/revoke">
          <input type="hidden" name="csrf" value="${req.adminSession.csrf}">
          <input name="confirmation" aria-label="Confirm cleanup ${escapeHtml(device.label)}" placeholder="Type REVOKE ${device.installation_id}" required autocomplete="off">
          <button class="secondary">Retry token cleanup</button></form>` : '';
        return `<tr><td>${escapeHtml(device.label)}<small class="muted-line">${escapeHtml(device.installation_id)}</small></td>
          <td>${badge(status)}${escapeHtml(pending)}</td><td>${date(device.expires_at)}</td><td>${button}</td></tr>`;
      }).join('');
      res.send(page({ title: 'Invites and devices', csrf: req.adminSession.csrf, active: 'devices',
        body: `${header('04 / Phone access', 'Invites & devices',
          'Create one private invite per phone. Revoke a phone here if its access must stop.')}
          <section class="card"><h2>Create an invite</h2><p>A code works once and expires in 24 hours. It is shown only on the next page; the database keeps its hash.</p>
          <form class="stack" method="post" action="/invites"><input type="hidden" name="csrf" value="${req.adminSession.csrf}"><label for="label">Phone label</label>
          <input id="label" name="label" maxlength="80" placeholder="e.g. Friend phone 2" required autocomplete="off">
          <button class="primary">Create one-use invite</button></form></section>
          <section class="card"><div class="sectionhead"><h2>Recent invites</h2><span>Latest 100</span></div>
          <div class="tablewrap"><table><thead><tr><th>Label</th><th>Status</th><th>Expires</th><th>Used</th><th>Action</th></tr></thead>
          <tbody>${inviteRows || '<tr><td colspan="5">No invites yet.</td></tr>'}</tbody></table></div></section>
          <section class="card"><div class="sectionhead"><h2>Phones</h2><span>Latest 100</span></div>
          <p>Revoking immediately blocks backend analysis and deletes this phone's stored reports and cached analyses. Cloudflare token deletion is attempted next.</p>
          <div class="tablewrap"><table><thead><tr><th>Phone</th><th>Status</th><th>Expires</th><th>Action</th></tr></thead>
          <tbody>${deviceRows || '<tr><td colspan="4">No enrolled phones yet.</td></tr>'}</tbody></table></div></section>` }));
    });
    app.post('/invites', async (req, res) => {
      const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
      let invite;
      try { invite = await deviceManagement.issue(label); }
      catch (error) {
        if (error instanceof TypeError) return errorPage(res, req.adminSession.csrf, error.message);
        throw error;
      }
      res.send(page({ title: 'New invite', csrf: req.adminSession.csrf, active: 'devices',
        body: `${header('Phone access / New invite', 'Invite created', 'Copy this code now and send it privately to one phone. It cannot be shown again.')}
          <section class="card"><label for="invite">One-time invite code</label>
          <input id="invite" value="${escapeHtml(invite.code)}" readonly autocomplete="off" spellcheck="false">
          <p>Expires ${date(new Date(invite.expiresAt))}. The first phone to redeem it receives its own credentials.</p>
          <p><a href="/devices">Return to invites &amp; devices</a></p></section>` }));
    });
    app.post('/invites/:hash/cancel', async (req, res) => {
      try {
        if (!await deviceManagement.cancel(req.params.hash)) {
          return errorPage(res, req.adminSession.csrf, 'This invite is no longer available to cancel.', 409);
        }
      } catch (error) {
        if (error instanceof TypeError) return errorPage(res, req.adminSession.csrf, error.message);
        throw error;
      }
      res.redirect(303, '/devices');
    });
    app.post('/devices/:id/revoke', async (req, res) => {
      const id = req.params.id;
      if (!UUID.test(id)) return errorPage(res, req.adminSession.csrf, 'Invalid phone ID.');
      if (req.body.confirmation !== `REVOKE ${id}`) {
        return errorPage(res, req.adminSession.csrf, 'Confirmation did not match. Phone access was not changed.');
      }
      const result = await deviceManagement.revoke(id);
      if (!result.found) return errorPage(res, req.adminSession.csrf, 'Phone not found.', 404);
      if (result.cloudflareCleanupPending) {
        return errorPage(res, req.adminSession.csrf,
          'Backend access is revoked. Cloudflare token removal is pending; retry from the devices page.', 503);
      }
      res.redirect(303, '/devices');
    });
  }
  app.get('/reports', async (req, res) => {
    const result = await pool.query(`SELECT client_report_id AS id, installation_id AS installation_id,
      review_status AS status, created_at, expires_at FROM production_reports
      WHERE expires_at > now() ORDER BY created_at DESC LIMIT 100`);
    const rows = result.rows.map((row) => `<tr><td><a href="/reports/${row.installation_id}/${row.id}">${escapeHtml(row.id)}</a></td>
      <td>${badge(row.status)}</td><td>${date(row.created_at)}</td><td>${date(row.expires_at)}</td></tr>`).join('');
    res.send(page({ title: 'Reports', csrf: req.adminSession.csrf, active: 'reports',
      body: `${header('01 / Inbox', 'Submitted reports', 'Only reports sent with explicit consent appear here. Open one to inspect its SMS text.')}
      <section class="card"><div class="sectionhead"><h2>Recent reports</h2><span>${result.rows.length} shown</span></div>
      <div class="tablewrap"><table><thead><tr><th>Report ID</th><th>Status</th><th>Received</th><th>Expires</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No reports received yet.</td></tr>'}</tbody></table></div></section>` }));
  });
  async function reportRow(installationId, reportId) {
    const result = await pool.query(`SELECT installation_id, client_report_id, content_encrypted,
      review_status, created_at, expires_at FROM production_reports
      WHERE installation_id = $1 AND client_report_id = $2 AND expires_at > now()`, [installationId, reportId]);
    return result.rows[0];
  }
  async function reportCandidate(reportId) {
    const result = await pool.query(`SELECT id, status, active_knowledge_id
      FROM rag_knowledge_staging WHERE external_id = $1`, [`report:${reportId}`]);
    return result.rows[0] || null;
  }
  function reportCandidatePath(candidate, fallback) {
    if (candidate?.status === 'APPROVED' && candidate.active_knowledge_id) {
      return `/knowledge/${candidate.active_knowledge_id}`;
    }
    if (candidate?.status === 'PENDING_EMBEDDING' || candidate?.status === 'PENDING_APPROVAL') {
      return `/staged/${candidate.id}`;
    }
    return fallback;
  }
  function reportCandidateLink(candidate) {
    const path = reportCandidatePath(candidate, '');
    if (!path) return '';
    const label = candidate.status === 'APPROVED'
      ? `Open approved example #${escapeHtml(candidate.active_knowledge_id)}`
      : `Open candidate #${escapeHtml(candidate.id)}`;
    return `<a href="${escapeHtml(path)}">${label}</a>`;
  }
  app.get('/reports/:installationId/:reportId', async (req, res) => {
    const { installationId, reportId } = req.params;
    if (!validReportIds(installationId, reportId)) return errorPage(res, req.adminSession.csrf, 'Invalid report ID.');
    const row = await reportRow(installationId, reportId);
    if (!row) return errorPage(res, req.adminSession.csrf, 'This report is unavailable.', 404);
    const existingCandidate = await reportCandidate(reportId);
    const report = codec.decryptReport(row.content_encrypted);
    const url = `/reports/${installationId}/${reportId}`;
    const candidateOpen = existingCandidate &&
      ['PENDING_EMBEDDING', 'PENDING_APPROVAL'].includes(existingCandidate.status);
    const statusForm = row.review_status === 'PENDING' && !candidateOpen &&
      existingCandidate?.status !== 'APPROVED' ? `<div class="actions">
      <form method="post" action="${url}/review"><input type="hidden" name="csrf" value="${req.adminSession.csrf}">
      <button class="secondary">Mark reviewed without RAG</button></form>
      <form method="post" action="${url}/dismiss"><input type="hidden" name="csrf" value="${req.adminSession.csrf}">
      <button class="danger">Dismiss report</button></form></div>` : '';
    const candidate = existingCandidate
      ? `<section class="card"><div class="sectionhead"><h2>RAG candidate</h2>${badge(existingCandidate.status)}</div>
        <p>This report has already been nominated as candidate #${escapeHtml(existingCandidate.id)}.
        ${candidateOpen ? 'The report stays pending while the candidate awaits a final decision.' : ''}
        ${reportCandidateLink(existingCandidate)}</p></section>`
      : row.review_status === 'PENDING' && report.consentScope === 'REVIEW_AND_RAG_CANDIDATE'
      ? `<section class="card"><div class="sectionhead"><h2>Prepare a RAG candidate</h2>${badge('PENDING')}</div>
        <p>Edit the text below to remove personal information. Choose the correct label yourself; the app's verdict is only a clue.</p>
        <form method="post" action="${url}/stage" class="stack">
          <input type="hidden" name="csrf" value="${req.adminSession.csrf}">
          <label for="content">Redacted example text</label><textarea id="content" name="content" rows="6" maxlength="2000" required>${escapeHtml(report.smsText)}</textarea>
          <div class="grid"><div><label for="label">Verified label</label><select id="label" name="label" required>
            <option value="">Choose a label</option><option value="SCAM">SCAM</option><option value="SAFE">SAFE</option></select></div>
            <div><label for="reviewer">Your name</label><input id="reviewer" name="reviewer" maxlength="100" required></div></div>
          <label class="checkbox"><input type="checkbox" name="confirmed" value="yes" required>
            I verified the label and removed names, phone numbers, account details, codes, and other personal information.</label>
          <button class="primary">Validate and stage candidate</button></form></section>` : '';
    res.send(page({ title: 'Report detail', csrf: req.adminSession.csrf, active: 'reports',
      body: `<p class="back"><a href="/reports">← All reports</a></p>${header('Report / Review', 'Review submitted SMS',
        'Decide whether this report needs action and whether a redacted example would help future analyses.')}
        <div class="grid"><section class="card"><h2>Report</h2><dl><dt>Status</dt><dd>${badge(row.review_status)}</dd>
          <dt>Type</dt><dd>${escapeHtml(report.reportType)}</dd><dt>Received</dt><dd>${date(row.created_at)}</dd>
          <dt>Retention ends</dt><dd>${date(row.expires_at)}</dd><dt>Consent</dt><dd>${escapeHtml(report.consentScope || 'Legacy review only')}</dd></dl></section>
          <section class="card"><h2>App observation</h2><dl><dt>Observed verdict</dt><dd>${escapeHtml(report.observedVerdict || '—')}</dd>
          <dt>Risk score</dt><dd>${escapeHtml(report.riskScore ?? '—')}</dd><dt>User remarks</dt><dd>${escapeHtml(report.remarks || 'None')}</dd></dl></section></div>
        <section class="card"><h2>Submitted SMS text</h2><p class="sms">${escapeHtml(report.smsText)}</p></section>
        ${candidate}${statusForm}` }));
  });
  for (const action of ['review', 'dismiss']) {
    app.post(`/reports/:installationId/:reportId/${action}`, async (req, res) => {
      const { installationId, reportId } = req.params;
      if (!validReportIds(installationId, reportId)) return errorPage(res, req.adminSession.csrf, 'Invalid report ID.');
      const candidate = await reportCandidate(reportId);
      if (candidate && ['PENDING_EMBEDDING', 'PENDING_APPROVAL'].includes(candidate.status)) {
        return errorPage(res, req.adminSession.csrf, 'Review the existing RAG candidate first.', 409);
      }
      const status = action === 'review' ? 'REVIEWED' : 'DISMISSED';
      const result = await pool.query(`UPDATE production_reports SET review_status = $3, reviewed_at = now()
        WHERE installation_id = $1 AND client_report_id = $2 AND review_status = 'PENDING'
        RETURNING client_report_id`, [installationId, reportId, status]);
      if (!result.rowCount) return errorPage(res, req.adminSession.csrf, 'This report is no longer pending.', 409);
      res.redirect(303, `/reports/${installationId}/${reportId}`);
    });
  }
  app.post('/reports/:installationId/:reportId/stage', async (req, res) => {
    const { installationId, reportId } = req.params;
    if (!validReportIds(installationId, reportId)) return errorPage(res, req.adminSession.csrf, 'Invalid report ID.');
    const row = await reportRow(installationId, reportId);
    if (!row || row.review_status !== 'PENDING' || row.expires_at <= new Date()) {
      return errorPage(res, req.adminSession.csrf, 'This report is no longer available for staging.', 409);
    }
    const report = codec.decryptReport(row.content_encrypted);
    if (report.consentScope !== 'REVIEW_AND_RAG_CANDIDATE') {
      return errorPage(res, req.adminSession.csrf, 'This report was not consented for RAG candidacy.', 403);
    }
    const existingCandidate = await reportCandidate(reportId);
    if (existingCandidate) {
      return res.redirect(303, reportCandidatePath(existingCandidate,
        `/reports/${installationId}/${reportId}`));
    }
    const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
    const reviewer = typeof req.body.reviewer === 'string' ? req.body.reviewer.trim() : '';
    const label = req.body.label;
    if (req.body.confirmed !== 'yes' || !content || content.length > 2000 ||
      !['SCAM', 'SAFE'].includes(label) || !reviewer || reviewer.length > 100) {
      return errorPage(res, req.adminSession.csrf, 'Review the text, select SCAM or SAFE, and confirm the redaction.');
    }
    let rowData;
    try {
      rowData = { externalId: `report:${reportId}`, content, label, reviewer,
        reviewedAt: new Date().toISOString(), sourceReference: `report:${reportId}`,
        rowNumber: 2, signature: signature(content) };
      await validateImport(pool, [rowData], corpus);
      const ids = await stageImport(pool, [rowData], corpus);
      const result = await embedPending(pool, embeddingService, ids);
      if (result.error) return errorPage(res, req.adminSession.csrf,
        'Candidate staged, but embedding is unavailable. It remains pending and can be retried later.', 503);
      res.redirect(303, `/staged/${ids[0]}`);
    } catch (error) {
      if (error.code === '23505' || /existing external_id/u.test(error.message)) {
        const candidate = await reportCandidate(reportId);
        if (candidate) return res.redirect(303, reportCandidatePath(candidate,
          `/reports/${installationId}/${reportId}`));
      }
      return errorPage(res, req.adminSession.csrf, error.message, 409);
    }
  });
  app.get('/staged', async (req, res) => {
    const rows = await listPending(pool);
    const items = rows.map((row) => `<li><a class="candidate-link" href="/staged/${escapeHtml(row.id)}">
      <span class="candidate-id"><span class="sr-only">Candidate ID: </span>#${escapeHtml(row.id)}</span>
      <span><span class="sr-only">Label: </span>${escapeHtml(row.label)}</span>
      <span><span class="sr-only">Status: </span>${badge(row.status)}</span>
      <span class="candidate-source"><span class="sr-only">Source: </span>${escapeHtml(row.source_reference)}</span>
      </a></li>`).join('');
    res.send(page({ title: 'RAG candidates', csrf: req.adminSession.csrf, active: 'staged',
      body: `${header('02 / Candidate review', 'RAG candidates', 'Staged examples are not used in analysis until you approve them.')}
      <section class="card">${items ? `<div class="candidate-head" aria-hidden="true"><span>ID</span><span>Label</span><span>Status</span><span>Source</span></div>
      <ul class="candidate-list">${items}</ul>` : '<p>No candidates awaiting approval.</p>'}</section>` }));
  });
  app.get('/staged/:id', async (req, res) => {
    if (!ID.test(req.params.id)) return errorPage(res, req.adminSession.csrf, 'Invalid candidate ID.');
    let entry;
    try { entry = await getReviewEntry(pool, req.params.id, corpus); }
    catch { return errorPage(res, req.adminSession.csrf, 'Candidate unavailable.', 404); }
    const checks = entry.duplicateCheckStatus.length ? entry.duplicateCheckStatus.join(', ') : 'PASS';
    const phrase = `APPROVE ${entry.id} AS ${entry.reviewer}`;
    const approval = checks === 'PASS' ? `<form class="stack" method="post" action="/staged/${entry.id}/approve">
      <input type="hidden" name="csrf" value="${req.adminSession.csrf}"><p>To make this example available to RAG,
      type <strong>${escapeHtml(phrase)}</strong> below.</p><label for="confirmation">Exact confirmation</label>
      <input id="confirmation" name="confirmation" required autocomplete="off"><button class="primary">Approve for RAG</button></form>`
      : `<p class="warning">Approval is blocked until the listed checks pass.</p>`;
    res.send(page({ title: 'Candidate detail', csrf: req.adminSession.csrf, active: 'staged',
      body: `<p class="back"><a href="/staged">← All candidates</a></p>${header('Candidate / Final review', `Candidate #${entry.id}`,
        'Read the exact text and verified label before approval.')}
        <section class="card"><dl><dt>Status</dt><dd>${badge(entry.status)}</dd><dt>Label</dt><dd>${escapeHtml(entry.label)}</dd>
        <dt>Reviewer</dt><dd>${escapeHtml(entry.reviewer)}</dd><dt>Source</dt><dd>${escapeHtml(entry.source_reference)}</dd>
        <dt>Validation</dt><dd>${escapeHtml(checks)}</dd></dl><h2>Redacted text</h2><p class="sms">${escapeHtml(entry.content)}</p></section>
        <section class="card"><h2>Final decision</h2>${approval}
        <form class="stack" method="post" action="/staged/${entry.id}/reject"><input type="hidden" name="csrf" value="${req.adminSession.csrf}">
        <label for="reason">Reason to reject</label><input id="reason" name="reason" maxlength="300" required>
        <button class="danger">Reject candidate</button></form></section>` }));
  });
  app.post('/staged/:id/approve', async (req, res) => {
    if (!ID.test(req.params.id)) return errorPage(res, req.adminSession.csrf, 'Invalid candidate ID.');
    let entry;
    try { entry = await getReviewEntry(pool, req.params.id, corpus); }
    catch { return errorPage(res, req.adminSession.csrf, 'Candidate unavailable.', 404); }
    if (req.body.confirmation !== `APPROVE ${entry.id} AS ${entry.reviewer}`) {
      return errorPage(res, req.adminSession.csrf, 'Confirmation did not match. Nothing was approved.');
    }
    try {
      const approved = await approveBatch(pool, [entry.id], entry.reviewer, corpus);
      const activeId = approved[0].activeId;
      const match = /^report:([0-9a-f-]+)$/iu.exec(entry.source_reference);
      if (match) await pool.query(`UPDATE production_reports SET review_status = 'REVIEWED', reviewed_at = now()
        WHERE client_report_id = $1 AND review_status = 'PENDING'`, [match[1]]);
      res.redirect(303, `/knowledge/${activeId}`);
    } catch (error) { return errorPage(res, req.adminSession.csrf, error.message, 409); }
  });
  app.post('/staged/:id/reject', async (req, res) => {
    if (!ID.test(req.params.id)) return errorPage(res, req.adminSession.csrf, 'Invalid candidate ID.');
    const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason || reason.length > 300) return errorPage(res, req.adminSession.csrf, 'Enter a short rejection reason.');
    const { rejectEntry } = require('../knowledge/adminRepository');
    try {
      await rejectEntry(pool, req.params.id, 'Dashboard reviewer', reason);
      res.redirect(303, '/staged');
    } catch (error) { return errorPage(res, req.adminSession.csrf, error.message, 409); }
  });
  app.get('/knowledge', async (req, res) => {
    const pageNumber = Number(req.query.page || 1);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 10000) {
      return errorPage(res, req.adminSession.csrf, 'Invalid page.');
    }
    const [count, entries] = await Promise.all([countActive(pool), listActive(pool, pageNumber, 20)]);
    const rows = entries.map((entry) => `<tr><td><a href="/knowledge/${entry.id}">#${entry.id}</a></td>
      <td>${escapeHtml(entry.label)}</td><td>${escapeHtml(entry.source_reference || entry.source_type)}</td>
      <td>${date(entry.approved_at)}</td></tr>`).join('');
    res.send(page({ title: 'Approved examples', csrf: req.adminSession.csrf, active: 'active',
      body: `${header('03 / Live knowledge', 'Approved RAG examples', `${count} active examples can be retrieved during authorized analyses.`)}
      <section class="card"><div class="tablewrap"><table><thead><tr><th>ID</th><th>Label</th><th>Source</th><th>Approved</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No examples on this page.</td></tr>'}</tbody></table></div>
      <p class="pager">Page ${pageNumber} · ${pageNumber > 1 ? `<a href="/knowledge?page=${pageNumber - 1}">Previous</a>` : ''}
      ${entries.length === 20 ? `<a href="/knowledge?page=${pageNumber + 1}">Next</a>` : ''}</p></section>` }));
  });
  app.get('/knowledge/:id', async (req, res) => {
    if (!ID.test(req.params.id)) return errorPage(res, req.adminSession.csrf, 'Invalid example ID.');
    let entry;
    try { entry = await showActive(pool, req.params.id); }
    catch { return errorPage(res, req.adminSession.csrf, 'Active example unavailable.', 404); }
    res.send(page({ title: 'Approved example', csrf: req.adminSession.csrf, active: 'active',
      body: `<p class="back"><a href="/knowledge">← Approved examples</a></p>${header('Live knowledge', `Example #${entry.id}`,
        'This example may be retrieved by the AI for similar authorized SMS analyses.')}
        <section class="card"><dl><dt>Label</dt><dd>${escapeHtml(entry.label)}</dd><dt>Source</dt><dd>${escapeHtml(entry.source_reference || '—')}</dd>
        <dt>Approved by</dt><dd>${escapeHtml(entry.approved_by)}</dd><dt>Approved at</dt><dd>${date(entry.approved_at)}</dd></dl>
        <h2>Example text</h2><p class="sms">${escapeHtml(entry.content)}</p></section>
        <section class="card"><h2>Remove from live retrieval</h2>
        <p>Deactivation keeps the audit record but stops future RAG retrieval of this example.</p>
        <form method="post" action="/knowledge/${entry.id}/deactivate" class="stack">
        <input type="hidden" name="csrf" value="${req.adminSession.csrf}">
        <label for="confirmation">Type DEACTIVATE ${entry.id}</label>
        <input id="confirmation" name="confirmation" required autocomplete="off">
        <button class="danger">Deactivate example</button></form></section>` }));
  });
  app.post('/knowledge/:id/deactivate', async (req, res) => {
    if (!ID.test(req.params.id)) return errorPage(res, req.adminSession.csrf, 'Invalid example ID.');
    if (req.body.confirmation !== `DEACTIVATE ${req.params.id}`) {
      return errorPage(res, req.adminSession.csrf, 'Confirmation did not match. Nothing was changed.');
    }
    const result = await pool.query(`UPDATE rag_knowledge SET is_active = false
      WHERE id = $1 AND is_active = true RETURNING id`, [req.params.id]);
    if (result.rowCount !== 1) return errorPage(res, req.adminSession.csrf, 'Example is not active.', 409);
    res.redirect(303, '/knowledge');
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    process.stderr.write(`Admin dashboard request failed: ${error.code || error.name || 'UNKNOWN'}\n`);
    return errorPage(res, req.adminSession?.csrf || '', 'The dashboard could not complete this request.', 503);
  });
  return app;
}

module.exports = { createAdminApp, escapeHtml, validReportIds, constantTimePassword };
