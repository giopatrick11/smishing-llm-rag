const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const CHECKPOINT_NAME = 'checkpoint.jsonl';

function ensureOutputDir(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const stats = fs.statSync(outputDir);
  if (!stats.isDirectory()) throw new Error('Output path is not a directory');
}

function acquireRunLock(outputDir) {
  ensureOutputDir(outputDir);
  const lockPath = path.join(outputDir, 'run.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (current.token === token) fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (!Number.isInteger(existing.pid) || existing.pid < 1) throw new Error('Invalid lock');
        process.kill(existing.pid, 0);
      } catch (checkError) {
        if (checkError.code === 'ESRCH') {
          fs.unlinkSync(lockPath);
          continue;
        }
        throw new Error('Evaluation output is locked; inspect run.lock before retrying');
      }
      throw new Error('Evaluation output is already in use by another process');
    }
  }
  throw new Error('Unable to acquire evaluation lock');
}

function privateWrite(filePath, data, flag) {
  const descriptor = fs.openSync(filePath, flag, 0o600);
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function metadataMatches(stored, expected, compatibleClassifierHashes = []) {
  if (isDeepStrictEqual(stored, expected)) return true;
  if (!compatibleClassifierHashes.includes(stored?.classifierSha256)) return false;
  return isDeepStrictEqual({ ...stored, classifierSha256: expected.classifierSha256 }, expected);
}

function openCheckpoint(outputDir, metadata, rows, { compatibleClassifierHashes = [] } = {}) {
  ensureOutputDir(outputDir);
  const filePath = path.join(outputDir, CHECKPOINT_NAME);
  const expectedRows = new Map(rows.map((row) => [row.messageId, row.groundTruth]));
  const completed = new Map();

  if (!fs.existsSync(filePath)) {
    if (['evaluation.json', 'evaluation.csv', 'evaluation-metrics.csv'].some((name) => fs.existsSync(path.join(outputDir, name)))) {
      throw new Error('Reports exist without a checkpoint; choose a new output directory');
    }
    privateWrite(filePath, `${JSON.stringify({ type: 'metadata', value: metadata })}\n`, 'wx');
  } else {
    const content = fs.readFileSync(filePath, 'utf8');
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline < 0) throw new Error('Checkpoint metadata is incomplete');
    if (lastNewline !== content.length - 1) {
      fs.truncateSync(filePath, Buffer.byteLength(content.slice(0, lastNewline + 1)));
    }
    const lines = content.slice(0, lastNewline).split('\n');
    let header;
    try {
      header = JSON.parse(lines[0]);
    } catch {
      throw new Error('Checkpoint metadata is invalid');
    }
    if (header.type !== 'metadata' || !metadataMatches(header.value, metadata, compatibleClassifierHashes)) {
      throw new Error('Checkpoint does not match this dataset, mapping, model, or classifier');
    }
    for (const line of lines.slice(1)) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('Checkpoint contains an invalid completed record');
      }
      if (record.type !== 'result' || !record.value || typeof record.value.messageId !== 'string') {
        throw new Error('Checkpoint contains an invalid completed record');
      }
      const result = record.value;
      if (!expectedRows.has(result.messageId) || expectedRows.get(result.messageId) !== result.groundTruth || completed.has(result.messageId)) {
        throw new Error('Checkpoint contains an unknown, mismatched, or duplicate message ID');
      }
      if (!Number.isFinite(result.inferenceDurationMs) || result.inferenceDurationMs < 0
        || (result.error ? result.prediction != null : !['SCAM', 'SAFE', 'SUSPICIOUS'].includes(result.prediction))) {
        throw new Error('Checkpoint contains an invalid result');
      }
      completed.set(result.messageId, result);
    }
  }

  function append(result) {
    if (!expectedRows.has(result.messageId) || expectedRows.get(result.messageId) !== result.groundTruth || completed.has(result.messageId)) {
      throw new Error('Cannot checkpoint an unknown or completed message ID');
    }
    const stored = {
      messageId: result.messageId,
      groundTruth: result.groundTruth,
      prediction: result.prediction,
      confidence: result.confidence,
      rationale: result.rationale,
      inferenceDurationMs: result.inferenceDurationMs,
      error: result.error,
    };
    for (const key of ['ruleScore', 'ruleClassification', 'matchedIndicators', 'ruleExplanation',
      'gemmaClassification', 'baselineGemmaClassification', 'ragEnabledClassification',
      'finalClassification', 'hybridClassification', 'verdictPolicy', 'verdictReason',
      'ragContext', 'correctedError', 'introducedError']) {
      if (Object.hasOwn(result, key)) stored[key] = result[key];
    }
    privateWrite(filePath, `${JSON.stringify({ type: 'result', value: stored })}\n`, 'a');
    completed.set(stored.messageId, stored);
  }

  return { completed, append, filePath };
}

function writeAtomic(filePath, data) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    privateWrite(temporary, data, 'wx');
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { openCheckpoint, acquireRunLock, writeAtomic, metadataMatches };
