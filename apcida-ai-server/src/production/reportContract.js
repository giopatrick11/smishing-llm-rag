const REPORT_TYPES = new Set([
  'Message was not scanned', 'Analysis did not complete', 'Scam was not detected',
  'Legitimate message was flagged', 'Other detection issue',
]);
const VERDICTS = new Set(['SAFE', 'SUSPICIOUS', 'SCAM', 'UNVERIFIED']);
const KEYS = new Set(['clientReportId', 'reportType', 'remarks', 'smsText',
  'messageSharingConsent', 'observedVerdict', 'riskScore']);

function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some((key) => !KEYS.has(key))) return null;
  if (typeof body.clientReportId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(body.clientReportId) ||
      !REPORT_TYPES.has(body.reportType)) return null;
  const remarks = body.remarks == null ? null : body.remarks;
  const smsText = body.smsText == null ? null : body.smsText;
  if ((remarks !== null && (typeof remarks !== 'string' || remarks.length > 500)) ||
      (smsText !== null && (typeof smsText !== 'string' || !smsText.length || smsText.length > 4000)) ||
      (smsText !== null && body.messageSharingConsent !== true) ||
      (smsText === null && body.messageSharingConsent !== false) ||
      (body.observedVerdict != null && !VERDICTS.has(body.observedVerdict)) ||
      (body.riskScore != null && (typeof body.riskScore !== 'number' ||
        !Number.isFinite(body.riskScore) || body.riskScore < 0 || body.riskScore > 100))) return null;
  return { clientReportId: body.clientReportId.toLowerCase(), reportType: body.reportType,
    remarks, smsText, messageSharingConsent: body.messageSharingConsent,
    observedVerdict: body.observedVerdict || null, riskScore: body.riskScore ?? null };
}

module.exports = { validateReport };
