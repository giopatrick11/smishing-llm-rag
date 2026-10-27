const POLICY_VERSION = 2;

function strongRagSupport(context) {
  if (!context || context.retrievedCount < 1) return false;
  const scam = Number(context.topScamSimilarity) || 0;
  const safe = Number(context.topSafeSimilarity) || 0;
  return scam >= 0.82 && scam >= safe + 0.05;
}

function resolveVerdict(gemmaClassification, rules, {
  shadowMode = true, policy = 'gemma', gemmaConfidence = 'MEDIUM', ragContext = null,
} = {}) {
  if (!['SCAM', 'SAFE', 'SUSPICIOUS'].includes(gemmaClassification)) throw new Error('Invalid Gemma classification');
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(gemmaConfidence)) throw new Error('Invalid Gemma confidence');
  if (!['gemma', 'corroborated-warning', 'evidence-weighted'].includes(policy)) throw new Error('Invalid verdict policy');
  const codes = new Set(rules?.matchedIndicators?.map((item) => item.code) || []);
  const has = (...names) => names.some((name) => codes.has(name));
  const legacyRisky = has('CREDENTIAL_REQUEST', 'ADVANCE_FEE', 'DELIVERY_FEE');
  const legacySupport = has('SUSPICIOUS_URL', 'OBSCURED_URL', 'AUTHORITY_CLAIM', 'COERCIVE_URGENCY');
  const ragSupport = strongRagSupport(ragContext);
  let classification = gemmaClassification;
  let reason = 'GEMMA_RETAINED';

  if (!shadowMode && policy === 'corroborated-warning' && gemmaClassification === 'SAFE'
    && rules?.classification === 'SCAM' && legacyRisky && legacySupport) {
    classification = 'SUSPICIOUS';
    reason = 'LEGACY_CORROBORATED_WARNING';
  }
  if (!shadowMode && policy === 'evidence-weighted') {
    const score = Number(rules?.score) || 0;
    const risky = has('CREDENTIAL_REQUEST', 'CREDENTIAL_FORM_REQUEST', 'ADVANCE_FEE',
      'PERSONAL_PAYMENT_REQUEST', 'GIFT_CARD_REQUEST', 'UNSAFE_APP_INSTALL');
    const support = has('AUTHORITY_CLAIM', 'ACCOUNT_PROBLEM_CLAIM', 'GOVERNMENT_PAYMENT_CLAIM',
      'FAMILY_EMERGENCY_CLAIM', 'FAMILY_IDENTITY_CLAIM', 'JOB_OR_SCHOLARSHIP_CLAIM',
      'SUSPICIOUS_URL', 'OBSCURED_URL', 'COERCIVE_URGENCY') || ragSupport;
    if (gemmaClassification === 'SAFE' && score >= 60 && risky && support
      && (gemmaConfidence === 'LOW' || ragSupport)) {
      classification = 'SUSPICIOUS';
      reason = 'CORROBORATED_WARNING';
    }
    // Only an explicit request to disclose a secret can turn uncertainty into SCAM.
    if (gemmaClassification === 'SUSPICIOUS' && score >= 60 && codes.has('CREDENTIAL_REQUEST')
      && support && (gemmaConfidence !== 'HIGH' || ragSupport)) {
      classification = 'SCAM';
      reason = 'CORROBORATED_CREDENTIAL_DISCLOSURE';
    }
  }
  return {
    classification,
    policy: shadowMode ? 'shadow' : policy,
    changed: classification !== gemmaClassification,
    reason,
    policyVersion: POLICY_VERSION,
  };
}

module.exports = { resolveVerdict, strongRagSupport, POLICY_VERSION };
