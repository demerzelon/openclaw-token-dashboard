#!/usr/bin/env node
/*
Generate JSON datasets for Token Usage Dashboard.
Reads local OpenClaw JSONL logs and workspaces to estimate context size.

Outputs into ./data/*.json

Design goals:
- No secrets
- Redact absolute paths
- Token estimates for files: approx chars/4 (safe heuristic)
*/

const fs = require('fs');
const path = require('path');

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/Users/eylonaviv/.openclaw';
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || path.join(OPENCLAW_DIR, 'workspaces');

const OUT_DIR = path.join(process.cwd(), 'data');

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function listFilesRecursive(root, { maxBytes = Infinity, exts = null, skipDirs = [] } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      const base = path.basename(cur);
      if (skipDirs.includes(base)) continue;
      let entries;
      try { entries = fs.readdirSync(cur); } catch { continue; }
      for (const e of entries) stack.push(path.join(cur, e));
    } else {
      if (st.size > maxBytes) continue;
      if (exts) {
        const ext = path.extname(cur).toLowerCase();
        if (!exts.includes(ext)) continue;
      }
      out.push({ file: cur, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

function readJsonLines(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return out;
}

function isoDateFromTimestamp(ts) {
  // ts can be ms number or ISO string
  if (!ts) return null;
  if (typeof ts === 'number') return new Date(ts).toISOString().slice(0, 10);
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function lastNDaysSet(n) {
  const set = new Set();
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    set.add(d.toISOString().slice(0, 10));
  }
  return set;
}

function redactPath(p) {
  // Make it publish-ish: hide username and absolute dirs
  return p
    .replace(/^\/Users\/[^/]+\/.openclaw\//, '/.openclaw/')
    .replace(/^\/Users\/[^/]+\/.openclaw\/workspaces\//, '/workspaces/')
    .replace(/^\/Users\/[^/]+\//, '/Users/<redacted>/');
}

function approxTokensFromChars(chars) {
  // rule of thumb; we expose as estimate
  return Math.ceil(chars / 4);
}

function buildContextTree(rootDir) {
  // tree nodes: {name, path, type, sizeBytes, charCount, tokenEst, children}
  function walk(dir) {
    const name = path.basename(dir);
    const node = {
      name,
      path: redactPath(dir),
      type: 'dir',
      sizeBytes: 0,
      tokenEst: 0,
      children: []
    };
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return node; }

    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.DS_Store') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const child = walk(p);
        node.sizeBytes += child.sizeBytes;
        node.tokenEst += child.tokenEst;
        node.children.push(child);
      } else {
        const ext = path.extname(ent.name).toLowerCase();
        const isText = ['.md', '.txt', '.json', '.yaml', '.yml'].includes(ext);
        const st = fs.statSync(p);
        let charCount = null;
        let tokenEst = null;
        if (isText && st.size < 2_000_000) {
          try {
            const content = fs.readFileSync(p, 'utf8');
            charCount = content.length;
            tokenEst = approxTokensFromChars(charCount);
          } catch {
            charCount = null;
            tokenEst = null;
          }
        }
        const fileNode = {
          name: ent.name,
          path: redactPath(p),
          type: 'file',
          sizeBytes: st.size,
          charCount,
          tokenEst
        };
        node.sizeBytes += st.size;
        node.tokenEst += tokenEst || 0;
        node.children.push(fileNode);
      }
    }

    // sort children: dirs first, then by tokenEst desc
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return (b.tokenEst || 0) - (a.tokenEst || 0);
    });

    return node;
  }

  return walk(rootDir);
}

function aggregateUsageFromSessions({ days = 5 } = {}) {
  const daysSet = lastNDaysSet(days);

  const sessionsRoot = path.join(OPENCLAW_DIR, 'agents');
  const sessionFiles = listFilesRecursive(sessionsRoot, {
    exts: ['.jsonl'],
    skipDirs: ['node_modules', '.git']
  }).filter(x => x.file.includes(`${path.sep}sessions${path.sep}`));

  // day -> model -> tokens
  const byDayModel = {};
  const byDayAgent = {};

  for (const f of sessionFiles) {
    let lines;
    try { lines = readJsonLines(f.file); } catch { continue; }

    for (const evt of lines) {
      if (evt?.type !== 'message') continue;
      const usage = evt?.usage || evt?.message?.usage;
      if (!usage?.totalTokens) continue;

      const day = isoDateFromTimestamp(evt.timestamp);
      if (!day || !daysSet.has(day)) continue;

      const model = evt?.model || evt?.message?.model || 'unknown';
      // session path looks like .../.openclaw/agents/<agent>/sessions/<file>.jsonl
      const parts = f.file.split(path.sep);
      const agentIdx = parts.lastIndexOf('agents');
      const agent = agentIdx >= 0 ? parts[agentIdx + 1] : 'unknown';

      byDayModel[day] ||= {};
      byDayModel[day][model] = (byDayModel[day][model] || 0) + usage.totalTokens;

      byDayAgent[day] ||= {};
      byDayAgent[day][agent] = (byDayAgent[day][agent] || 0) + usage.totalTokens;
    }
  }

  return { byDayModel, byDayAgent };
}

function aggregateUsageFromCronRuns({ days = 5 } = {}) {
  const daysSet = lastNDaysSet(days);
  const runsRoot = path.join(OPENCLAW_DIR, 'cron', 'runs');
  if (!exists(runsRoot)) return { byDayJob: {}, byJob: {} };

  const runFiles = listFilesRecursive(runsRoot, { exts: ['.jsonl'] });
  const byDayJob = {}; // day -> jobId -> tokens
  const byJob = {};    // jobId -> {tokens, lastRunDay}

  for (const f of runFiles) {
    const jobId = path.basename(f.file).replace(/\.jsonl$/, '');
    let lines;
    try { lines = readJsonLines(f.file); } catch { continue; }

    for (const evt of lines) {
      // Cron run logs often mirror message objects, but we’ll be robust.
      const usage = evt?.usage || evt?.message?.usage || null;
      const total = usage?.totalTokens || 0;
      if (!total) continue;

      const ts = evt?.timestamp || evt?.ts;
      const day = isoDateFromTimestamp(ts);
      if (!day || !daysSet.has(day)) continue;

      byDayJob[day] ||= {};
      byDayJob[day][jobId] = (byDayJob[day][jobId] || 0) + total;

      byJob[jobId] ||= { tokens: 0, lastRunDay: null };
      byJob[jobId].tokens += total;
      byJob[jobId].lastRunDay = day;
    }
  }

  return { byDayJob, byJob };
}

function topFilesByTokenEst(tree, limit = 20, prefix = '') {
  const out = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'file') {
      if (node.tokenEst != null) out.push({ path: node.path, tokenEst: node.tokenEst, sizeBytes: node.sizeBytes });
      return;
    }
    for (const c of node.children || []) walk(c);
  }
  walk(tree);
  out.sort((a, b) => b.tokenEst - a.tokenEst);
  return out.slice(0, limit);
}

function main() {
  if (!exists(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const usage = aggregateUsageFromSessions({ days: 5 });
  const cron = aggregateUsageFromCronRuns({ days: 5 });

  const workspacesTree = buildContextTree(WORKSPACES_DIR);
  const topFiles = topFilesByTokenEst(workspacesTree, 50);

  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: 5,
    redaction: {
      policy: 'absolute-path-redaction',
      note: 'Paths are redacted for public GitHub Pages publishing.'
    },
    usage,
    cron,
    context: {
      root: redactPath(WORKSPACES_DIR),
      tree: workspacesTree,
      topFiles
    }
  };

  fs.writeFileSync(path.join(OUT_DIR, 'dashboard.json'), JSON.stringify(payload, null, 2));

  // convenience split files
  fs.writeFileSync(path.join(OUT_DIR, 'usage_by_day_model.json'), JSON.stringify(usage.byDayModel, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'usage_by_day_agent.json'), JSON.stringify(usage.byDayAgent, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'cron_by_day_job.json'), JSON.stringify(cron.byDayJob, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'context_tree.json'), JSON.stringify(workspacesTree, null, 2));

  console.log('Wrote data files to:', OUT_DIR);
}

main();
