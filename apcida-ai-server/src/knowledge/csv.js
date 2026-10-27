const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { z } = require('zod');
const { parseCsv } = require('../evaluation/csv');
const { signature } = require('./dedupe');

const KNOWLEDGE_HEADERS = ['external_id', 'content', 'label', 'reviewer', 'reviewed_at', 'source_reference'];
const timestamp = z.iso.datetime({ offset: true });

function parseKnowledgeCsv(csvText) {
  const records = parseCsv(csvText);
  if (records.length < 2) throw new Error('Knowledge CSV must contain a header and at least one message');
  const headers = records[0].map((header) => header.trim());
  if (headers.length !== KNOWLEDGE_HEADERS.length || new Set(headers).size !== headers.length
    || KNOWLEDGE_HEADERS.some((name) => !headers.includes(name))) {
    throw new Error(`Knowledge CSV must have exactly these columns: ${KNOWLEDGE_HEADERS.join(', ')}`);
  }
  const indexes = Object.fromEntries(KNOWLEDGE_HEADERS.map((name) => [name, headers.indexOf(name)]));
  const ids = new Set();
  const rows = [];
  for (let i = 1; i < records.length; i += 1) {
    const values = records[i];
    const rowNumber = i + 1;
    if (values.length !== headers.length) throw new Error(`Knowledge CSV row ${rowNumber} has the wrong number of fields`);
    const get = (name) => values[indexes[name]].trim();
    const row = {
      externalId: get('external_id'),
      content: get('content'),
      label: get('label').toUpperCase(),
      reviewer: get('reviewer'),
      reviewedAt: get('reviewed_at'),
      sourceReference: get('source_reference'),
      rowNumber,
    };
    if (!row.externalId || row.externalId.length > 128 || ids.has(row.externalId)) throw new Error(`Knowledge CSV row ${rowNumber} has an invalid or duplicate external_id`);
    if (!row.content || row.content.length > 2000) throw new Error(`Knowledge CSV row ${rowNumber} has invalid content`);
    if (!['SCAM', 'SAFE'].includes(row.label)) throw new Error(`Knowledge CSV row ${rowNumber} has an invalid label`);
    if (!row.reviewer || row.reviewer.length > 100 || !timestamp.safeParse(row.reviewedAt).success) {
      throw new Error(`Knowledge CSV row ${rowNumber} has invalid reviewer metadata`);
    }
    if (!row.sourceReference || row.sourceReference.length > 200) throw new Error(`Knowledge CSV row ${rowNumber} has an invalid source_reference`);
    row.signature = signature(row.content);
    ids.add(row.externalId);
    rows.push(row);
  }
  return rows;
}

function loadEvaluationCorpus(filePath, textColumn) {
  const bytes = fs.readFileSync(filePath);
  const records = parseCsv(bytes.toString('utf8'));
  if (!records.length) throw new Error('Evaluation corpus CSV is empty');
  const headers = records[0].map((header) => header.trim());
  if (!textColumn || headers.filter((header) => header === textColumn).length !== 1) {
    throw new Error('Evaluation text column is missing or ambiguous');
  }
  const index = headers.indexOf(textColumn);
  const entries = [];
  for (let i = 1; i < records.length; i += 1) {
    if (records[i].length !== headers.length || !records[i][index].trim()) {
      throw new Error(`Evaluation corpus row ${i + 1} is malformed`);
    }
    entries.push({ id: `evaluation-row-${i + 1}`, signature: signature(records[i][index]) });
  }
  if (!entries.length) throw new Error('Evaluation corpus has no messages');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), entries };
}

module.exports = { KNOWLEDGE_HEADERS, parseKnowledgeCsv, loadEvaluationCorpus };
