const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { signature, findDuplicate } = require('../knowledge/dedupe');

const PIPELINE_FILES = [
  './worker.js',
  '../services/ollama.js', '../services/embeddings.js', '../services/rag.js',
  '../services/rules.js', '../services/hybrid.js', '../services/verdict.js',
  '../db/knowledgeRepository.js',
];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createStudyWorker({ pool, repository, slotRepository, analyzer, model, ollamaUrl,
  requestTimeoutMs = null, fetchImpl = fetch, gapMs = 3000, audit = () => {} }) {
  if (!pool?.query || !pool?.connect || !repository?.queueNext || !slotRepository?.acquireSlot ||
    !analyzer?.analyze || !model || !ollamaUrl) throw new TypeError('Study worker dependencies required');
  let running = false;
  const pipelineHash = sha256(Buffer.concat([
    ...PIPELINE_FILES.map((file) => fs.readFileSync(path.resolve(__dirname, file))),
    Buffer.from(JSON.stringify({ requestTimeoutMs })),
  ]));

  async function knowledgeSnapshot() {
    const result = await pool.query(`SELECT id, label, content, normalized_hash, embedding_model
      FROM public.rag_knowledge
      WHERE is_active = true AND approved_by IS NOT NULL AND approved_at <= now()
      ORDER BY id`);
    return { hash: sha256(JSON.stringify(result.rows)), rows: result.rows };
  }
  async function knowledgeHash() { return (await knowledgeSnapshot()).hash; }

  async function modelDigest() {
    const response = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Model list unavailable');
    const models = (await response.json()).models;
    const entry = Array.isArray(models) && models.find((item) =>
      item.name === model || item.model === model);
    if (!entry?.digest) throw new Error('Study model digest unavailable');
    return entry.digest;
  }

  async function queueNext() {
    const knowledge = await knowledgeHash();
    const digest = await modelDigest();
    const prior = await pool.query(`SELECT DISTINCT model_name, model_digest, pipeline_sha256, knowledge_sha256
      FROM study.predictions LIMIT 2`);
    if (prior.rows.some((row) => row.model_name !== model ||
      row.model_digest !== digest || row.pipeline_sha256 !== pipelineHash ||
      row.knowledge_sha256 !== knowledge)) {
      throw new Error('Study model, pipeline, or RAG knowledge changed; start a separately versioned study');
    }
    const ids = await repository.queueNext(10, { model, modelDigest: digest,
      pipelineHash, knowledgeHash: knowledge });
    start();
    return ids;
  }

  async function drain() {
    while (true) {
      if (!await repository.hasQueued()) return;
      const owner = randomUUID();
      if (!await slotRepository.acquireSlot(owner, 300)) {
        await delay(3000);
        continue;
      }
      let item;
      let knowledgeClient;
      let knowledgeLocked = false;
      try {
        knowledgeClient = await pool.connect();
        const lock = await knowledgeClient.query(
          "SELECT pg_try_advisory_lock_shared(hashtext('apcida_rag_knowledge')) AS locked");
        if (!lock.rows[0]?.locked) {
          await delay(3000);
          continue;
        }
        knowledgeLocked = true;
        item = await repository.claimQueued();
        if (!item) return;
        const snapshot = await knowledgeSnapshot();
        if (item.knowledge_sha256 !== snapshot.hash ||
          item.model_digest !== await modelDigest()) {
          await repository.requeue(item.id);
          audit('STUDY_SNAPSHOT_CHANGED');
          return 'PAUSED';
        }
        let overlap;
        try {
          overlap = findDuplicate({ signature: signature(item.text) },
            snapshot.rows.map((row) => ({ id: row.id, signature: signature(row.content) })));
        } catch {
          await repository.exclude(item.id, 'NONCOMPARABLE_TEXT');
          audit('STUDY_EXCLUDED_NONCOMPARABLE', item.id);
          continue;
        }
        if (overlap) {
          await repository.exclude(item.id, `RAG_OVERLAP_${overlap.kind}`);
          audit('STUDY_EXCLUDED_RAG_OVERLAP', item.id);
          continue;
        }
        const started = Date.now();
        try {
          const result = await analyzer.analyze({ sender: 'Unknown', text: item.text,
            receivedAt: new Date(item.created_at).toISOString() },
          { signal: AbortSignal.timeout(240000) });
          await repository.finish(item.id, result);
          audit('STUDY_ANALYSIS_COMPLETED', item.id, Date.now() - started);
        } catch (error) {
          const code = /^[A-Z_]{3,40}$/u.test(error?.code) ? error.code : 'ANALYSIS_FAILED';
          await repository.finish(item.id, null, code);
          audit('STUDY_ANALYSIS_FAILED', item.id, Date.now() - started);
        }
      } finally {
        try {
          if (knowledgeClient) {
            try {
              if (knowledgeLocked) await knowledgeClient.query(
                "SELECT pg_advisory_unlock_shared(hashtext('apcida_rag_knowledge'))");
            } finally { knowledgeClient.release(); }
          }
        } finally { await slotRepository.releaseSlot(owner); }
      }
      await delay(gapMs); // Leave a short opening for live SMS between study items.
    }
  }

  function start() {
    if (running) return;
    running = true;
    setImmediate(async () => {
      let outcome = 'PAUSED';
      try { outcome = await drain(); }
      catch { audit('STUDY_WORKER_PAUSED'); }
      finally {
        running = false;
        if (outcome !== 'PAUSED') {
          try { if (await repository.hasQueued()) start(); } catch { audit('STUDY_WORKER_PAUSED'); }
        }
      }
    });
  }

  async function resume() {
    await repository.resetRunning();
    start();
  }

  return { queueNext, resume, start, knowledgeHash, pipelineHash };
}

module.exports = { createStudyWorker };
