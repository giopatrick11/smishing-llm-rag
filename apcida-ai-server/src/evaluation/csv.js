const { z } = require('zod');

function parseCsv(input) {
  const text = input.replace(/^\uFEFF/, '');
  const records = [];
  let record = [];
  let field = '';
  let state = 'start';

  function finishRecord() {
    record.push(field);
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
    field = '';
    state = 'start';
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          state = 'afterQuote';
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === ',') {
      record.push(field);
      field = '';
      state = 'start';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      finishRecord();
    } else if (state === 'start' && char === '"') {
      state = 'quoted';
    } else if (state === 'afterQuote' && (char === ' ' || char === '\t')) {
      // Whitespace between a closing quote and delimiter is ignored.
    } else if (state === 'afterQuote' || char === '"') {
      throw new Error(`Malformed CSV near character ${i + 1}`);
    } else {
      field += char;
      state = 'unquoted';
    }
  }

  if (state === 'quoted') throw new Error('Malformed CSV: unterminated quoted field');
  if (record.length > 0 || field !== '' || state === 'afterQuote') finishRecord();
  return records;
}

function loadDataset(csvText, mapping) {
  const records = parseCsv(csvText);
  if (records.length === 0) throw new Error('CSV is empty');
  const headers = records[0].map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new Error('CSV headers must be nonempty and unique');
  }
  if (mapping.textColumn === mapping.labelColumn) throw new Error('Text and label columns must differ');
  if (mapping.idColumn === mapping.textColumn) throw new Error('The ID column cannot be the SMS text column');

  const columns = {};
  for (const [key, name] of Object.entries(mapping)) {
    if (name == null) continue;
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`CSV column not found: ${name}`);
    columns[key] = index;
  }

  const rows = [];
  const ids = new Set();
  const timestamp = z.iso.datetime({ offset: true });
  for (let i = 1; i < records.length; i += 1) {
    const values = records[i];
    const rowNumber = i + 1;
    if (values.length !== headers.length) throw new Error(`CSV row ${rowNumber} has ${values.length} fields; expected ${headers.length}`);
    const text = values[columns.textColumn].trim();
    const groundTruth = values[columns.labelColumn].trim().toUpperCase();
    const messageId = columns.idColumn == null ? `row-${String(i).padStart(6, '0')}` : values[columns.idColumn].trim();
    if (!text || text.length > 2000) throw new Error(`CSV row ${rowNumber} has empty or overlong SMS text`);
    if (!['SCAM', 'SAFE'].includes(groundTruth)) throw new Error(`CSV row ${rowNumber} has an invalid ground-truth label`);
    if (!messageId || messageId.length > 128 || ids.has(messageId)) throw new Error(`CSV row ${rowNumber} has an empty, overlong, or duplicate message ID`);
    ids.add(messageId);

    const sender = columns.senderColumn == null ? undefined : values[columns.senderColumn].trim() || undefined;
    const receivedAt = columns.receivedAtColumn == null ? undefined : values[columns.receivedAtColumn].trim() || undefined;
    if (sender && sender.length > 100) throw new Error(`CSV row ${rowNumber} has an overlong sender`);
    if (receivedAt && !timestamp.safeParse(receivedAt).success) throw new Error(`CSV row ${rowNumber} has an invalid receivedAt timestamp`);
    rows.push({ messageId, groundTruth, text, sender, receivedAt });
  }
  if (rows.length === 0) throw new Error('CSV contains no SMS rows');
  return rows;
}

function escapeCsv(value) {
  const string = value == null ? '' : String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function resultsToCsv(results, { extended = false } = {}) {
  const columns = ['messageId', 'groundTruth', 'prediction', 'confidence', 'rationale', 'inferenceDurationMs', 'error'];
  if (extended) columns.push('ruleScore', 'ruleClassification', 'matchedIndicators', 'ruleExplanation',
    'gemmaClassification', 'baselineGemmaClassification', 'ragEnabledClassification',
    'finalClassification', 'hybridClassification', 'verdictPolicy', 'verdictReason',
    'ragContext', 'correctedError', 'introducedError');
  return [columns.join(','), ...results.map((result) => columns.map((column) => escapeCsv(
    column === 'matchedIndicators' ? JSON.stringify(result[column] || [])
      : column === 'ragContext' && result[column] ? JSON.stringify(result[column]) : result[column],
  )).join(','))].join('\n') + '\n';
}

function comparisonsToCsv(results) {
  const columns = ['messageId', 'groundTruth', 'ruleScore', 'matchedIndicators', 'gemmaClassification',
    'baselineGemmaClassification', 'ragEnabledClassification', 'hybridClassification',
    'correctedError', 'introducedError', 'verdictReason', 'error'];
  return [columns.join(','), ...results.map((result) => columns.map((column) => escapeCsv(
    column === 'matchedIndicators' ? JSON.stringify(result[column] || []) : result[column],
  )).join(','))].join('\n') + '\n';
}

function metricsToCsv(metrics) {
  const rows = [['metric', 'numerator', 'denominator', 'value']];
  for (const name of ['scamRecall', 'scamPrecision', 'safeFalsePositiveWarningRate', 'binaryAccuracyDecisive']) {
    const item = metrics[name];
    rows.push([name, item.numerator, item.denominator, item.value]);
  }
  for (const name of ['threeWayExactAccuracy', 'scamClassRecall', 'scamClassPrecision']) {
    const item = metrics[name];
    rows.push([name, item.numerator, item.denominator, item.value]);
  }
  for (const [truth, predictions] of Object.entries(metrics.confusionMatrix)) {
    for (const [prediction, count] of Object.entries(predictions)) rows.push([`confusionMatrix.${truth}.${prediction}`, '', '', count]);
  }
  for (const [name, count] of Object.entries(metrics.threeWayOutputDistribution)) {
    rows.push([`threeWayOutputDistribution.${name}`, '', '', count]);
  }
  for (const [name, count] of Object.entries(metrics.errorsByCode)) {
    rows.push([`errorsByCode.${name}`, '', '', count]);
  }
  for (const name of ['totalRows', 'validPredictionCount', 'errorCount', 'totalInferenceDurationMs']) {
    rows.push([name, '', '', metrics[name]]);
  }
  for (const [name, value] of Object.entries(metrics.latencyMs)) rows.push([`latencyMs.${name}`, '', '', value]);
  if (metrics.hybridComparison) {
    for (const [name, value] of Object.entries(metrics.hybridComparison)) rows.push([`hybridComparison.${name}`, '', '', value]);
  }
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\n') + '\n';
}

module.exports = { parseCsv, loadDataset, resultsToCsv, comparisonsToCsv, metricsToCsv };
