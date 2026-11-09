const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAdminApp, escapeHtml, constantTimePassword } = require('../src/admin-web/app');

function setup({ consentScope = 'REVIEW_AND_RAG_CANDIDATE', expired = false,
  publicEnabled = false, deviceManagement = null, stagedRows = [] } = {}) {
  const reportId = '853cc24d-751b-4607-ab0a-02d16ade89a6';
  const installationId = '232288ec-44cd-44d3-8721-a6d9ad784a29';
  const state = { status: 'PENDING', writes: 0 };
  const expiresAt = new Date(Date.now() + (expired ? -60000 : 60000));
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('FROM rag_knowledge_staging') && sql.includes('ORDER BY id')) {
        return { rows: stagedRows };
      }
      if (sql.includes('FROM rag_knowledge_staging') && sql.includes('external_id = $1')) {
        return { rows: stagedRows.filter((row) => row.external_id === params[0]) };
      }
      if (sql.includes('FROM production_reports') && sql.includes('ORDER BY')) {
        return { rows: [{ id: reportId, installation_id: installationId, status: state.status,
          created_at: new Date(), expires_at: expiresAt }] };
      }
      if (sql.includes('FROM production_reports') && sql.includes('content_encrypted')) {
        return { rows: [{ installation_id: installationId, client_report_id: reportId,
          content_encrypted: Buffer.from('test'), review_status: state.status,
          created_at: new Date(), expires_at: expiresAt }] };
      }
      if (sql.includes('UPDATE production_reports')) {
        state.writes += 1;
        if (state.status !== 'PENDING') return { rowCount: 0 };
        state.status = params[2];
        return { rowCount: 1 };
      }
      throw new Error('Unexpected query');
    },
  };
  const app = createAdminApp({ pool,
    codec: { decryptReport: () => ({ smsText: '<script>alert(1)</script>',
      reportType: 'Other detection issue', consentScope,
      observedVerdict: 'SCAM', riskScore: 60 }) },
    loginPassword: 'a'.repeat(64), embeddingService: { embed: async () => [] },
    corpus: { sha256: 'f'.repeat(64), entries: [] }, publicEnabled, deviceManagement });
  return { app, reportId, installationId, state };
}

async function authenticatedSession(base) {
  const login = await request(base, '/login', { method: 'POST',
    headers: { origin: 'http://127.0.0.1:3022', 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${'a'.repeat(64)}` });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')[0].split(';')[0];
  const page = await request(base, '/reports', { headers: { cookie } });
  const csrf = /name="csrf" value="([a-f0-9]+)"/u.exec(await page.text())[1];
  return { cookie, csrf };
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(base, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + pathname);
    const req = http.request(url, { method: options.method || 'GET',
      headers: { host: '127.0.0.1:3022', ...(options.headers || {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode,
        headers: { get: (name) => res.headers[name.toLowerCase()] },
        text: async () => body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('HTML escaping and login comparison keep report content inert', () => {
  assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
  assert.equal(constantTimePassword('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(constantTimePassword('bad', 'a'.repeat(64)), false);
});

test('each staged candidate is one full-entry link to its review page', async () => {
  const { app } = setup({ stagedRows: [
    { id: 7, label: 'SCAM', status: 'PENDING_APPROVAL', source_reference: 'report:example' },
    { id: 8, label: 'SAFE', status: 'PENDING_EMBEDDING', source_reference: '<script>' },
  ] });
  await withServer(app, async (base) => {
    const { cookie } = await authenticatedSession(base);
    const response = await request(base, '/staged', { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<li><a class="candidate-link" href="\/staged\/7">[\s\S]*?SCAM[\s\S]*?PENDING APPROVAL[\s\S]*?report:example[\s\S]*?<\/a><\/li>/u);
    assert.match(html, /<li><a class="candidate-link" href="\/staged\/8">[\s\S]*?SAFE[\s\S]*?PENDING EMBEDDING[\s\S]*?&lt;script&gt;[\s\S]*?<\/a><\/li>/u);
    assert.doesNotMatch(html, /<script>/u);
  });
});

test('a pending report with an existing candidate links to it instead of staging again', async () => {
  const reportId = '853cc24d-751b-4607-ab0a-02d16ade89a6';
  const { app, installationId, state } = setup({ stagedRows: [{ id: 3,
    external_id: `report:${reportId}`, status: 'PENDING_APPROVAL',
    label: 'SAFE', source_reference: `report:${reportId}` }] });
  await withServer(app, async (base) => {
    const { cookie, csrf } = await authenticatedSession(base);
    const path = `/reports/${installationId}/${reportId}`;
    const detail = await request(base, path, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.match(html, /Open candidate #3/u);
    assert.match(html, /href="\/staged\/3"/u);
    assert.match(html, /report stays pending while the candidate awaits a final decision/u);
    assert.doesNotMatch(html, /Validate and stage candidate/u);
    assert.doesNotMatch(html, /Mark reviewed without RAG/u);
    const repeated = await request(base, `${path}/stage`, { method: 'POST',
      headers: { cookie, origin: 'http://127.0.0.1:3022',
        'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
    assert.equal(repeated.status, 303);
    assert.equal(repeated.headers.get('location'), '/staged/3');
    assert.equal(state.status, 'PENDING');
    assert.equal(state.writes, 0);
    const review = await request(base, `${path}/review`, { method: 'POST',
      headers: { cookie, origin: 'http://127.0.0.1:3022',
        'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${csrf}` });
    assert.equal(review.status, 409);
    assert.equal(state.status, 'PENDING');
  });
});

test('dashboard requires login, exact Origin, and CSRF for report actions', async () => {
  const { app, reportId, installationId, state } = setup();
  await withServer(app, async (base) => {
    const reportPath = `/reports/${installationId}/${reportId}`;
    const guest = await request(base, reportPath);
    assert.equal(guest.status, 303);
    assert.equal(guest.headers.get('location'), '/login');
    const login = await request(base, '/login', { method: 'POST',
      headers: { origin: 'http://127.0.0.1:3022', 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${'a'.repeat(64)}` });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')[0].split(';')[0];
    const detail = await request(base, reportPath, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
    assert.doesNotMatch(html, /<script>alert/u);
    const csrf = /name="csrf" value="([a-f0-9]+)"/u.exec(html)[1];
    const badOrigin = await request(base, `${reportPath}/review`, { method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${csrf}` });
    assert.equal(badOrigin.status, 403);
    const badCsrf = await request(base, `${reportPath}/review`, { method: 'POST',
      headers: { cookie, origin: 'http://127.0.0.1:3022', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'csrf=bad' });
    assert.equal(badCsrf.status, 403);
    assert.equal(state.writes, 0);
    const reviewed = await request(base, `${reportPath}/review`, { method: 'POST',
      headers: { cookie, origin: 'http://127.0.0.1:3022', 'content-type': 'application/x-www-form-urlencoded' },
      body: `csrf=${csrf}` });
    assert.equal(reviewed.status, 303);
    assert.equal(state.status, 'REVIEWED');
    assert.equal(state.writes, 1);
  });
});

test('public hostname refuses an unencrypted origin request', async () => {
  const { app } = setup();
  await withServer(app, async (base) => {
    const response = await request(base, '/login', { headers: { host: 'admin.apcida.stream' } });
    assert.equal(response.status, 403);
    const tunneled = await request(base, '/login', { headers: {
      host: 'admin.apcida.stream', 'x-forwarded-proto': 'https',
    } });
    assert.equal(tunneled.status, 403);
  });
});

test('Cloudflare public sign-in accepts opaque Origin while report actions keep CSRF protection', async () => {
  const { app, reportId, installationId, state } = setup({ publicEnabled: true });
  await withServer(app, async (base) => {
    const publicHeaders = { host: 'admin.apcida.stream', 'x-forwarded-proto': 'https',
      origin: 'null', 'content-type': 'application/x-www-form-urlencoded' };
    const login = await request(base, '/login', { method: 'POST', headers: publicHeaders,
      body: `password=${'a'.repeat(64)}` });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')[0].split(';')[0];
    const reportPath = `/reports/${installationId}/${reportId}`;
    const detail = await request(base, reportPath, { headers: { ...publicHeaders, cookie } });
    assert.equal(detail.status, 200);
    const csrf = /name="csrf" value="([a-f0-9]+)"/u.exec(await detail.text())[1];
    const missingCsrf = await request(base, `${reportPath}/review`, { method: 'POST',
      headers: { ...publicHeaders, cookie }, body: '' });
    assert.equal(missingCsrf.status, 403);
    assert.equal(state.writes, 0);
    const reviewed = await request(base, `${reportPath}/review`, { method: 'POST',
      headers: { ...publicHeaders, cookie }, body: `csrf=${csrf}` });
    assert.equal(reviewed.status, 303);
    assert.equal(state.status, 'REVIEWED');
  });
});

test('staging refuses missing consent and expired reports before any RAG write', async () => {
  for (const options of [{ consentScope: 'REVIEW_ONLY' }, { expired: true }]) {
    const { app, reportId, installationId, state } = setup(options);
    await withServer(app, async (base) => {
      const { cookie, csrf } = await authenticatedSession(base);
      const response = await request(base, `/reports/${installationId}/${reportId}/stage`, {
        method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:3022',
          'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, content: 'Synthetic example', reviewer: 'Owner',
          label: 'SCAM', confirmed: 'yes' }).toString(),
      });
      assert.equal(response.status, options.expired ? 409 : 403);
      assert.equal(state.writes, 0);
    });
  }
});

test('invite and phone actions require login, CSRF, and exact revoke confirmation', async () => {
  const phoneId = '232288ec-44cd-44d3-8721-a6d9ad784a29';
  const inviteHash = 'c'.repeat(64);
  const state = { issues: 0, cancellations: 0, revocations: 0 };
  const manager = {
    listInvites: async () => [{ invite_hash: inviteHash, label: 'Friend phone',
      expires_at: new Date(Date.now() + 86400000), used_at: null, canceled_at: null }],
    listDevices: async () => [{ installation_id: phoneId, label: 'Friend phone',
      expires_at: new Date(Date.now() + 86400000), revoked_at: null }],
    issue: async () => { state.issues += 1; return { code: 'example-one-time-code',
      expiresAt: Date.now() + 86400000 }; },
    cancel: async () => { state.cancellations += 1; return true; },
    revoke: async () => { state.revocations += 1; return { found: true,
      cloudflareCleanupPending: false }; },
  };
  const { app } = setup({ deviceManagement: manager });
  await withServer(app, async (base) => {
    const guest = await request(base, '/devices');
    assert.equal(guest.status, 303);
    const { cookie, csrf } = await authenticatedSession(base);
    const pageResponse = await request(base, '/devices', { headers: { cookie } });
    assert.equal(pageResponse.status, 200);
    const html = await pageResponse.text();
    assert.match(html, /Friend phone/u);
    assert.match(html, /AVAILABLE/u);
    assert.match(html, /name="csrf"/u);
    const headers = { cookie, origin: 'http://127.0.0.1:3022',
      'content-type': 'application/x-www-form-urlencoded' };
    assert.equal((await request(base, '/invites', { method: 'POST', headers,
      body: 'label=Another' })).status, 403);
    assert.equal(state.issues, 0);
    const issued = await request(base, '/invites', { method: 'POST', headers,
      body: new URLSearchParams({ csrf, label: 'Another' }).toString() });
    assert.equal(issued.status, 200);
    assert.match(await issued.text(), /example-one-time-code/u);
    assert.equal(state.issues, 1);
    const subsequent = await request(base, '/devices', { headers: { cookie } });
    assert.doesNotMatch(await subsequent.text(), /example-one-time-code/u);
    const mismatch = await request(base, `/devices/${phoneId}/revoke`, { method: 'POST', headers,
      body: new URLSearchParams({ csrf, confirmation: 'REVOKE' }).toString() });
    assert.equal(mismatch.status, 400);
    assert.equal(state.revocations, 0);
    const revoked = await request(base, `/devices/${phoneId}/revoke`, { method: 'POST', headers,
      body: new URLSearchParams({ csrf, confirmation: `REVOKE ${phoneId}` }).toString() });
    assert.equal(revoked.status, 303);
    assert.equal(state.revocations, 1);
    const canceled = await request(base, `/invites/${inviteHash}/cancel`, { method: 'POST', headers,
      body: new URLSearchParams({ csrf }).toString() });
    assert.equal(canceled.status, 303);
    assert.equal(state.cancellations, 1);
  });
});
