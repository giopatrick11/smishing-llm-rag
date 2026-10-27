// Heuristic evidence for review. No sender, domain, or payment destination is verified.
const VERSION = 2;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9][a-z0-9.-]+\.[a-z]{2,12}(?:\/[\w/?#%&=.+-]*)?/giu;
const SECRET = /\b(?:otp|one[- ]time (?:pin|password|code)|six[- ]digit (?:otp|code)|sms code|verification code|login code|recovery code|pin|password|passcode|cvv|security code|security answers?|login credentials?|banking credentials?|banking login|bank login|administrator login code|login|username|card details|atm pin)\b/iu;
const DISCLOSE = /\b(?:send|share|reply with|replying with|text back|reveal|disclose|provide|give|submit|ibigay|ipadala|isend|i-send|i-reply|ihatag|ipasa|isubmit|i-submit|ipakita)\b/iu;
const ENTER = /\b(?:enter|type|verify|update|confirm|ilagay|i-enter|i-type|i-verify|i-update|i-click|pindutin|i-tap)\b/iu;
const NEGATIVE_SHARE = /\b(?:do not|don't|never|huwag|wag|ayaw|dili)\b.{0,30}\b(?:share|send|ibigay|ipadala|ihatag|i-share|i-send)\b/giu;
const PAYMENT_VERB = /\b(?:pay|settle|deposit|transfer|send money|send funds|send it back|need money|buy|purchase|bayad|bayaran|magbayad|mobayad|bayri|hulog|maghulog|padala|ipadala|i-send|isend|magpadala)\b/iu;
const PAYMENT_OBJECT = /\b(?:money|funds|cash|kwarta|pera|bayad|payment|fee|charge|deposit|tax|fine|multa|bill|wallet|account|gift cards?|php|piso)\b/iu;
const SELF_CLAIM = /\b(?:we are|this is|i am|i'm|from|official|representative|agent|kami|ako|taga|mula|gikan|kuno)\b/iu;
const AUTHORITY = /\b(?:bank|bdo|bpi|metrobank|gcash|maya|e-wallet|wallet|mobile network|sim provider|telecom|police|court|government|gobyerno|ahensiya|bir|sss|philhealth|hr|manager|teacher|school|security team|support|customer service|tech support|refund desk|courier|parcel office|company|kompanya)\b/iu;
const ACCOUNT_PROBLEM = /\b(?:account|e-wallet|banking|sim|subscription|payroll|deposit|profile|business listing|employment|enrollment|scholarship|refund|payment|card)\b.{0,70}\b(?:fail(?:ed|ure)?|expire[ds]?|suspend(?:ed)?|suspension|block(?:ed)?|lock(?:ed)?|remove[ds]?|cancel(?:led|ed|ation)?|charge[ds]?|forfeit(?:ed)?|reactivat(?:e|ion)|reversal|problem|problema|na-expire|makakansela|mawawala|ma-suspend)\b|\b(?:fail(?:ed|ure)?|expire[ds]?|suspend(?:ed)?|suspension|block(?:ed)?|lock(?:ed)?|remove[ds]?|cancel(?:led|ed|ation)?|charge[ds]?|forfeit(?:ed)?|reactivat(?:e|ion)|reversal|problem|problema|na-expire|makakansela|mawawala|ma-suspend)\b.{0,70}\b(?:account|e-wallet|banking|sim|subscription|payroll|deposit|profile|business listing|employment|enrollment|scholarship|refund|payment|card)\b/iu;

function indicator(code, category, score, explanation) {
  return { code, category, score, explanation };
}

function near(left, right, text, distance = 85) {
  const a = left.exec(text);
  const b = right.exec(text);
  return !!(a && b && Math.abs(a.index - b.index) <= distance);
}

function analyzeRules(sms) {
  const text = typeof sms === 'string' ? sms : sms?.text;
  if (typeof text !== 'string') throw new TypeError('SMS text is required');
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const withoutWarnings = normalized.replace(NEGATIVE_SHARE, ' ');
  const indicators = [];
  const add = (condition, code, category, score, explanation) => {
    if (condition) indicators.push(indicator(code, category, score, explanation));
  };

  const urls = [...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[),.!?]+$/u, ''));
  let urlScore = 0;
  let urlCode = null;
  for (const value of urls) {
    const raw = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
    let url;
    try { url = new URL(raw); } catch { continue; }
    const host = url.hostname.toLocaleLowerCase();
    let score = 5;
    let code = 'LINK_PRESENT';
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) || host.startsWith('xn--') || /\.(?:xyz|top|click|site)$/u.test(host)) {
      score = 45; code = 'SUSPICIOUS_URL';
    } else if (/^(?:bit\.ly|tinyurl\.com|t\.co|cutt\.ly)$/u.test(host) || url.username || /@/u.test(value)) {
      score = 35; code = 'OBSCURED_URL';
    }
    if (score > urlScore) { urlScore = score; urlCode = code; }
  }
  if (urlCode) indicators.push(indicator(urlCode, 'url', Math.min(80, urlScore), urlCode === 'LINK_PRESENT'
    ? 'Contains a link; the link alone is weak evidence.' : 'Contains a suspicious or obscured address.'));

  const organizationNeedsSecret = /\b(?:we|bank|team|namin|namo|kami)\b.{0,25}\b(?:need|needs|kailangan|kinahanglan)\b.{0,45}\b(?:otp|pin|password|cvv|code|login)\b|\b(?:kailangan|kinahanglan)\b.{0,20}\b(?:namin|namo)\b.{0,45}\b(?:otp|pin|password|cvv|code|login)\b/iu.test(withoutWarnings);
  const secretDisclosure = near(DISCLOSE, SECRET, withoutWarnings) || organizationNeedsSecret ||
    (SECRET.test(withoutWarnings) && /\b(?:in this reply|sa reply|sa among agent|sa aming agent)\b/iu.test(withoutWarnings));
  const credentialForm = !secretDisclosure && SECRET.test(normalized) && ENTER.test(normalized)
    && (urls.length > 0 || /\b(?:link|form|website|site|portal|claim|refund|reversal)\b/iu.test(normalized));
  add(secretDisclosure, 'CREDENTIAL_REQUEST', 'credentials', 55, 'Requests disclosure of a secret or verification code.');
  add(credentialForm, 'CREDENTIAL_FORM_REQUEST', 'credentials', 35, 'Directs a credential into a link or form.');
  const identityRequest = near(/\b(?:send|share|submit|provide|upload|ibigay|ipadala|i-submit|ihatag)\b/iu,
    /\b(?:personal id|valid id|id photo|identity document|government id)\b/iu, normalized);
  add(identityRequest, 'IDENTITY_DOCUMENT_REQUEST', 'credentials', 35, 'Requests a personal identity document.');

  const paymentAction = PAYMENT_VERB.test(normalized) && PAYMENT_OBJECT.test(normalized);
  const personalDestination = /\b(?:personal|private|individual|unfamiliar|other|new|bag-ong|bagong|this)\b.{0,25}\b(?:wallet|account|number)|\b(?:wallet|account)\b.{0,25}\b(?:below|representative|agent)\b/iu.test(normalized);
  const personalPayment = paymentAction && personalDestination;
  const newNumberMoney = paymentAction && /\b(?:family member|relative|mama|mother|father|sister|brother)\b/iu.test(normalized)
    && /\bnew number\b/iu.test(normalized) && /\b(?:do not call|don't call|ayaw pagtawag)\b/iu.test(normalized);
  add(newNumberMoney, 'NEW_NUMBER_MONEY_REQUEST', 'payment', 35, 'Requests money from a claimed family member on a new number while discouraging contact.');
  add(personalPayment, 'PERSONAL_PAYMENT_REQUEST', 'payment', 35, 'Requests payment to a personal or changed destination.');
  const giftCard = /\b(?:gift cards?|prepaid cards?)\b/iu.test(normalized)
    && /\b(?:buy|purchase|send|codes?|bilhin|bumili|ipalit|palit)\b/iu.test(normalized);
  add(giftCard, 'GIFT_CARD_REQUEST', 'payment', 45, 'Requests gift cards or their codes.');
  const advance = /\b(?:processing fee|release (?:fee|charge)|activation fee|registration fee|clearance deposit|upfront (?:fee|insurance)|advance (?:fee|processing|payment)|withdrawal tax|verification fee|recovery fee|handling fee|identity-check charge|bayad muna|magbayad muna|bayri una|deposit first|pay first)\b/iu.test(normalized)
    && (paymentAction || /\b(?:first|before|muna|una|advance)\b/iu.test(normalized));
  add(advance, 'ADVANCE_FEE', 'payment', 40, 'Requests an upfront fee for a claimed benefit or service.');
  const delivery = /\b(?:package|parcel|delivery|shipment|courier|padala|pakete)\b/iu.test(normalized)
    && /\b(?:fee|charge|customs|clearance|redelivery|bayad|bayaran|magbayad|mobayad|handling)\b/iu.test(normalized) && paymentAction;
  add(delivery, 'DELIVERY_FEE', 'payment', 35, 'Requests payment for a claimed delivery.');
  const appInstall = /\b(?:install|open|download|i-install|i-open|i-download|ablihi|i-klik)\b.{0,45}\b(?:apk|remote[- ]control (?:app|application)|remote access (?:app|application))\b|\bapk\b.{0,45}\b(?:install|open|download)\b/iu.test(normalized);
  add(appInstall, 'UNSAFE_APP_INSTALL', 'software', 45, 'Directs installation or opening of an APK or remote-control app.');

  const riskyRequest = secretDisclosure || credentialForm || identityRequest || paymentAction || advance || giftCard || appInstall;
  const authorityClaim = riskyRequest && AUTHORITY.test(normalized) &&
    (SELF_CLAIM.test(normalized) || /\b(?:bank alert|security team|hr notice|payroll update)\b/iu.test(normalized));
  add(authorityClaim, 'AUTHORITY_CLAIM', 'claim', 20, 'Claims organizational or personal authority with a risky request.');
  const accountProblem = riskyRequest && ACCOUNT_PROBLEM.test(normalized);
  add(accountProblem, 'ACCOUNT_PROBLEM_CLAIM', 'claim', 20, 'Claims an account or service problem while requesting risky action.');
  const familyEmergency = paymentAction && /\b(?:family|relative|mama|mother|father|sister|brother|anak|inahan|papa)\b/iu.test(normalized)
    && /\b(?:injured|hospital|emergency|urgent|accident|new number|bag-ong account|bagong account)\b/iu.test(normalized);
  add(newNumberMoney, 'FAMILY_IDENTITY_CLAIM', 'claim', 25, 'Claims a family identity from a new number.');
  add(familyEmergency, 'FAMILY_EMERGENCY_CLAIM', 'claim', 25, 'Claims a family emergency with a money request.');
  const recoveryClaim = riskyRequest && /\b(?:recover|recovery|lost|stolen|nawalang|naibalik|maibalik)\b.{0,45}\b(?:funds|money|pera|account)\b|\b(?:funds|money|pera)\b.{0,45}\b(?:recover|recovery|lost|stolen|nawalang|naibalik|maibalik)\b/iu.test(normalized);
  add(recoveryClaim, 'RECOVERY_CLAIM', 'claim', 25, 'Promises recovery of lost money while requesting a credential or fee.');
  const transferReversal = paymentAction && /\b(?:accidentally sent|sent money|wrong transfer|mistaken transfer|ibalik|refund)\b/iu.test(normalized)
    && /\b(?:back|return|other account|ibang account|new account)\b/iu.test(normalized);
  add(transferReversal, 'TRANSFER_REVERSAL_CLAIM', 'claim', 25, 'Claims an accidental transfer and requests payment to another destination.');
  const government = riskyRequest && /\b(?:court|police|traffic|tax|refund|multa|fine|government|gobyerno|bir|ayuda|cash assistance|financial assistance)\b/iu.test(normalized)
    && /\b(?:fine|multa|settlement|tax|refund|charge|payment|bayad|bayaran|claim|approved|agent|officer|identity-check)\b/iu.test(normalized);
  add(government, 'GOVERNMENT_PAYMENT_CLAIM', 'claim', 25, 'Uses a government payment or benefit claim with a risky request.');
  const prize = riskyRequest && /\b(?:won|winner|prize|reward|cashback|lottery|jackpot|nanalo|panalo|premyo|nadaog|daog|gantimpala|ayuda|financial assistance|tabang pinansyal|tulong pinansyal|cash assistance|raffle)\b/iu.test(normalized);
  add(prize, 'PRIZE_OR_AID_CLAIM', 'claim', 25, 'Offers a prize, reward, or aid tied to a risky action.');
  const opportunity = riskyRequest && /\b(?:job|work from home|hiring|recruitment|trabaho|hanapbuhay|empleyo|panginabuhi|scholarship|enrollment|loan|housing loan|credit limit)\b/iu.test(normalized);
  add(opportunity, 'JOB_OR_SCHOLARSHIP_CLAIM', 'claim', 25, 'Uses a job, scholarship, or loan claim with a risky request.');
  add(delivery && !government, 'DELIVERY_CLAIM', 'claim', 20, 'Uses a delivery claim with a fee request.');

  const threatOrUrgency = /\b(?:arrest|legal action|account (?:will be )?(?:blocked|suspended|closed)|disconnect|terminated|penalty|fine|demanda|aresto|kakanselahin|putlon|masuspinde|ma-suspend|ma-block|forfeit|lost|removed|unless|or you will|now|today|immediately|within \d+ (?:hour|minute)|final notice|last chance|ngayon|agad|kaagad|karun|dayon|dali|before|bago|sa loob ng|ayaw na pagtawag|do not call)\b/iu.test(normalized);
  add(threatOrUrgency && riskyRequest, 'COERCIVE_URGENCY', 'pressure', 20, 'Uses urgency or a threat with a risky request.');

  // Maximum one indicator per independent evidence category. Repeated words and
  // multiple URLs cannot stack, and phrase/URL totals have separate caps.
  const byCategory = new Map();
  for (const item of indicators) {
    const previous = byCategory.get(item.category);
    if (!previous || item.score > previous.score) byCategory.set(item.category, item);
  }
  const matchedIndicators = [...byCategory.values()];
  const phraseScore = Math.min(60, matchedIndicators.filter((item) => item.category !== 'url').reduce((sum, item) => sum + item.score, 0));
  const cappedUrlScore = Math.min(80, matchedIndicators.find((item) => item.category === 'url')?.score || 0);
  const score = phraseScore + cappedUrlScore;
  return {
    score, phraseScore, urlScore: cappedUrlScore,
    classification: score >= 60 ? 'SCAM' : score >= 30 ? 'SUSPICIOUS' : 'SAFE',
    matchedIndicators,
    explanation: matchedIndicators.length ? matchedIndicators.map((item) => item.explanation).join(' ') : 'No configured scam indicators matched.',
    rulesVersion: VERSION,
  };
}

module.exports = { analyzeRules, RULES_VERSION: VERSION };
