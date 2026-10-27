const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { loadDatabaseUrl, loadEvaluationConfig } = require('../config/env');
const { createDatabasePool, checkRagDatabase } = require('../db/pool');
const { createEmbeddingService } = require('../services/embeddings');
const { requireAdmin } = require('./adminAuth');
const { parseKnowledgeCsv, loadEvaluationCorpus } = require('./csv');
const { getReviewPage, approveBatch, parseSelectedIds, validatePage } = require('./batchReview');
const { getApproveAllPreview, parseIds, createApprovalPlan, applyApproveAll } = require('./approveAll');
const {
  stageImport, embedPending, listPending, showEntry, approveEntry,
  rejectEntry, countActive,
} = require('./adminRepository');

const HELP = `Usage: npm run knowledge -- COMMAND [options]

Commands (all require RAG_ADMIN_KEY and APCIDA_ADMIN_TOKEN):
  import --file FILE [--evaluation-csv FILE --evaluation-text-column NAME]
  embed-pending
  pending
  show --id ID
  review-batch --page N [--page-size 10] --evaluation-csv FILE --evaluation-text-column NAME [--list-only | --approver NAME]
  approve-all --approver NAME [--preview] [--evaluation-csv FILE --evaluation-text-column NAME]
  approve --id ID --approver NAME --confirm-reviewed
  reject --id ID --approver NAME --reason TEXT
  count

Import validates every row and checks duplicates before staging any row.
Embedding runs sequentially. Batch review requires an interactive terminal and an exact typed confirmation before approval.`;

function parseOptions(args, allowed, booleanFlags = []) {
  const options = {};
  const accepted = new Set(allowed);
  const booleans = new Set(booleanFlags);
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!accepted.has(flag) || options[flag] != null) throw new Error(`Invalid or duplicate option: ${flag}`);
    if (booleans.has(flag)) {
      options[flag] = true;
    } else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      options[flag] = value;
    }
  }
  return options;
}

function positiveId(value) {
  if (!/^\d+$/.test(value || '') || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error('A positive numeric --id is required');
  }
  return value;
}

function person(value) {
  if (!value || value.trim().length < 1 || value.trim().length > 100) throw new Error('A valid --approver is required');
  return value.trim();
}

function formatReviewPage(page) {
  const lines = [`Pending review page ${page.page}/${page.pages || 1} (${page.total} pending; showing ${page.entries.length})`];
  for (const entry of page.entries) {
    const checks = entry.duplicateCheckStatus.length ? entry.duplicateCheckStatus.join(', ') : 'PASS';
    lines.push(`\nStaged ID: ${entry.id} | Message ID: ${JSON.stringify(entry.external_id)} | Status: ${entry.status}`);
    lines.push(`Content: ${JSON.stringify(entry.content)}`);
    lines.push(`Label: ${entry.label} | Reviewer: ${JSON.stringify(entry.reviewer)} | Reviewed at: ${entry.reviewed_at?.toISOString?.() || 'invalid'}`);
    lines.push(`Source: ${JSON.stringify(entry.source_reference)} | Duplicate/validation check: ${checks}`);
  }
  return `${lines.join('\n')}\n`;
}

async function reviewBatchSession(page, { ask, print, approve, approver }) {
  print(formatReviewPage(page));
  if (!page.entries.length) return [];
  const selected = parseSelectedIds(await ask('IDs from this page to approve, comma-separated (Enter to skip): '), page.entries);
  if (!selected.length) {
    print('No entries selected; nothing changed.\n');
    return [];
  }
  const selectedRows = page.entries.filter((entry) => selected.includes(String(entry.id)));
  const blocked = selectedRows.filter((entry) => entry.duplicateCheckStatus.length);
  if (blocked.length) throw new Error(`Selected IDs have unresolved checks: ${blocked.map((entry) => entry.id).join(', ')}`);
  const phrase = `APPROVE ${selected.join(',')} AS ${approver}`;
  if ((await ask(`Type ${JSON.stringify(phrase)} to confirm ${selected.length} approvals: `)).trim() !== phrase) {
    print('Confirmation did not match; nothing changed.\n');
    return [];
  }
  const approved = await approve(selected);
  print(`Approved ${approved.length} selected entries.\n`);
  return approved;
}

function formatApproveAllPreview(preview) {
  const lines = [
    `PENDING_APPROVAL entries: ${preview.pendingCount}`,
    `Eligible for approval: ${preview.eligibleIds.length}`,
    `Blocked by unresolved checks: ${preview.blocked.length}`,
    `Eligible staged IDs: ${preview.eligibleIds.join(', ') || '(none)'}`,
  ];
  for (const entry of preview.blocked) lines.push(`Blocked ID ${entry.id}: ${entry.problems.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

async function approveAllSession(preview, { ask, print, apply, approver }) {
  print(formatApproveAllPreview(preview));
  if (!preview.pendingCount) {
    print('Nothing pending; no changes.\n');
    return null;
  }
  const excluded = parseIds(await ask('IDs to exclude from this run (comma-separated, Enter for none): '), preview.snapshotIds);
  const rejected = parseIds(await ask('IDs to reject (comma-separated, Enter for none): '), preview.snapshotIds);
  const reason = rejected.length ? await ask('Reason for rejecting those IDs: ') : null;
  const plan = createApprovalPlan(preview, excluded, rejected, reason);
  print(`Final plan: approve ${plan.approveIds.length}, reject ${plan.rejectIds.length}, exclude ${plan.excludeIds.length}.\n`);
  const phrase = `APPROVE ${plan.approveIds.length} REJECT ${plan.rejectIds.length} AS ${approver}`;
  if ((await ask(`Type ${JSON.stringify(phrase)} to confirm: `)).trim() !== phrase) {
    print('Confirmation did not match; nothing changed.\n');
    return null;
  }
  const result = await apply(plan);
  print(`Approved ${result.approved}, rejected ${result.rejected}, excluded ${result.excluded}.\n`);
  return result;
}

async function execute(command, args, pool) {
  switch (command) {
    case 'import': {
      const options = parseOptions(args, ['--file', '--evaluation-csv', '--evaluation-text-column']);
      if (!options['--file']) throw new Error('--file is required');
      if (Boolean(options['--evaluation-csv']) !== Boolean(options['--evaluation-text-column'])) {
        throw new Error('--evaluation-csv and --evaluation-text-column must be supplied together');
      }
      const rows = parseKnowledgeCsv(fs.readFileSync(path.resolve(options['--file']), 'utf8'));
      const evaluation = options['--evaluation-csv']
        ? loadEvaluationCorpus(path.resolve(options['--evaluation-csv']), options['--evaluation-text-column'])
        : null;
      const ids = await stageImport(pool, rows, evaluation);
      process.stdout.write(`Staged ${ids.length} entries; evaluation contamination check ${evaluation ? 'passed' : 'not supplied'}.\n`);
      const result = await embedPending(pool, createEmbeddingService(loadEvaluationConfig()), ids);
      process.stdout.write(`Embedded ${result.embedded}/${result.attempted} staged entries. Manual approval is required.\n`);
      if (result.error) throw new Error(`Embedding stopped: ${result.error}. Run embed-pending to resume.`);
      break;
    }
    case 'embed-pending': {
      if (args.length) throw new Error('embed-pending takes no options');
      const result = await embedPending(pool, createEmbeddingService(loadEvaluationConfig()));
      process.stdout.write(`Embedded ${result.embedded}/${result.attempted} pending entries.\n`);
      if (result.error) throw new Error(`Embedding stopped: ${result.error}. Run embed-pending to resume.`);
      break;
    }
    case 'pending': {
      if (args.length) throw new Error('pending takes no options');
      process.stdout.write(`${JSON.stringify(await listPending(pool), null, 2)}\n`);
      break;
    }
    case 'show': {
      const options = parseOptions(args, ['--id']);
      const entry = await showEntry(pool, positiveId(options['--id']));
      process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      break;
    }
    case 'review-batch': {
      const options = parseOptions(args,
        ['--page', '--page-size', '--evaluation-csv', '--evaluation-text-column', '--approver', '--list-only'],
        ['--list-only']);
      if (!options['--evaluation-csv'] || !options['--evaluation-text-column']) {
        throw new Error('Batch review requires --evaluation-csv and --evaluation-text-column');
      }
      if (options['--list-only'] && options['--approver']) throw new Error('--list-only cannot be combined with --approver');
      if (!options['--list-only'] && !options['--approver']) throw new Error('--approver is required for interactive batch approval');
      const page = options['--page'] == null ? 1 : Number(options['--page']);
      const pageSize = options['--page-size'] == null ? 10 : Number(options['--page-size']);
      validatePage(page, pageSize);
      const corpus = loadEvaluationCorpus(path.resolve(options['--evaluation-csv']), options['--evaluation-text-column']);
      const reviewPage = await getReviewPage(pool, { page, pageSize, corpus });
      if (options['--list-only']) {
        process.stdout.write(formatReviewPage(reviewPage));
        break;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required for batch approval');
      const approver = person(options['--approver']);
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await reviewBatchSession(reviewPage, {
          ask: (question) => terminal.question(question),
          print: (message) => process.stdout.write(message),
          approver,
          approve: (ids) => approveBatch(pool, ids, approver, corpus),
        });
      } finally {
        terminal.close();
      }
      break;
    }
    case 'approve-all': {
      const options = parseOptions(args,
        ['--approver', '--evaluation-csv', '--evaluation-text-column', '--preview'], ['--preview']);
      const approver = person(options['--approver']);
      if (Boolean(options['--evaluation-csv']) !== Boolean(options['--evaluation-text-column'])) {
        throw new Error('--evaluation-csv and --evaluation-text-column must be supplied together');
      }
      const corpusPath = path.resolve(options['--evaluation-csv'] || path.join(__dirname, '../../../dataset/apcida_synthetic_sms_200.csv'));
      const corpus = loadEvaluationCorpus(corpusPath, options['--evaluation-text-column'] || 'sms_text');
      const preview = await getApproveAllPreview(pool, corpus);
      if (options['--preview']) {
        process.stdout.write(formatApproveAllPreview(preview));
        break;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required for approve-all');
      const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await approveAllSession(preview, {
          ask: (question) => terminal.question(question),
          print: (message) => process.stdout.write(message),
          approver,
          apply: (plan) => applyApproveAll(pool, plan, approver, corpus),
        });
      } finally {
        terminal.close();
      }
      break;
    }
    case 'approve': {
      const options = parseOptions(args, ['--id', '--approver', '--confirm-reviewed'], ['--confirm-reviewed']);
      if (!options['--confirm-reviewed']) throw new Error('--confirm-reviewed is required for manual approval');
      const activeId = await approveEntry(pool, positiveId(options['--id']), person(options['--approver']));
      process.stdout.write(`Approved staged entry ${options['--id']} as active knowledge record ${activeId}.\n`);
      break;
    }
    case 'reject': {
      const options = parseOptions(args, ['--id', '--approver', '--reason']);
      if (!options['--reason'] || options['--reason'].trim().length > 300) throw new Error('A short --reason is required');
      await rejectEntry(pool, positiveId(options['--id']), person(options['--approver']), options['--reason'].trim());
      process.stdout.write(`Rejected staged entry ${options['--id']}.\n`);
      break;
    }
    case 'count': {
      if (args.length) throw new Error('count takes no options');
      process.stdout.write(`Active approved knowledge records: ${await countActive(pool)}\n`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command || '(missing)'}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  let pool;
  try {
    requireAdmin();
    pool = createDatabasePool(loadDatabaseUrl());
    await checkRagDatabase(pool);
    await execute(command, args, pool);
  } catch (error) {
    process.stderr.write(`Knowledge command failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

if (require.main === module) main();

module.exports = {
  parseOptions, execute, formatReviewPage, reviewBatchSession,
  formatApproveAllPreview, approveAllSession,
};
