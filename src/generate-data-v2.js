#!/usr/bin/env node
/*
Token Dashboard data generator (v2)

Goals:
- Split payload into small JSON files
- Lazy-load workspace trees by root
- Keep redacted/publish-ish paths
- No file contents
- Token estimate heuristic: ~ chars/4

Outputs:
  data/meta.json
  data/models_daily_5d.json
  data/agents_daily_5d.json
  data/cron_daily_5d.json
  data/top_files_50.json
  data/workspace_roots.json
  data/workspace_tree/<rootId>.json

Notes:
- Session logs: ~/.openclaw/agents/<agent>/sessions/<session>.jsonl
- Cron runs:    ~/.openclaw/cron/runs/<jobId>.jsonl
*/

const fs = require('fs');
const path = require('path');

const OPENCLAW_DIR = process.env.OPENCLAW_DIR || '/Users/eylonaviv/.openclaw';
const WORKSPACES_DIR = process.env.WORKSPACES_DIR || path.join(OPENCLAW_DIR, 'workspaces');
const OUT_DIR = path.join(process.cwd(), 'data');
const TREE_DIR = path.join(OUT_DIR, 'workspace_tree');

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 5);

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }
function exists(p){ try { fs.accessSync(p); return true; } catch { return false; } }

function listFilesRecursive(root, { exts = null, include = null, skipDirs = [] } = {}){
  const out = [];
  const stack = [root];
  while (stack.length){
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()){
      const base = path.basename(cur);
      if (skipDirs.includes(base)) continue;
      let entries;
      try { entries = fs.readdirSync(cur); } catch { continue; }
      for (const e of entries) stack.push(path.join(cur, e));
    } else {
      if (exts){
        const ext = path.extname(cur).toLowerCase();
        if (!exts.includes(ext)) continue;
      }
      if (include && !include(cur)) continue;
      out.push(cur);
    }
  }
  return out;
}

function readJsonLines(filePath){
  const txt = fs.readFileSync(filePath, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of lines){
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function isoDate(ts){
  if (!ts) return null;
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0,10);
}

function lastNDaysSet(n){
  const set = new Set();
  const today = new Date();
  for (let i=0;i<n;i++){
    const d = new Date(today);
    d.setDate(today.getDate()-i);
    set.add(d.toISOString().slice(0,10));
  }
  return set;
}

function redactPath(p){
  return p
    .replace(/^\/Users\/[^/]+\/.openclaw\/workspaces\//, '/workspaces/')
    .replace(/^\/Users\/[^/]+\/.openclaw\//, '/.openclaw/')
    .replace(/^\/Users\/[^/]+\//, '/Users/<redacted>/');
}

function approxTokensFromChars(chars){ return Math.ceil(chars/4); }

function isTextExt(ext){
  return ['.md','.txt','.json','.yaml','.yml'].includes(ext);
}

function buildWorkspaceTree(rootDir){
  function walk(dir){
    const name = path.basename(dir);
    const node = { name, path: redactPath(dir), type: 'dir', sizeBytes: 0, tokenEst: 0, children: [] };
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return node; }

    for (const ent of entries){
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.DS_Store') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()){
        const child = walk(p);
        node.sizeBytes += child.sizeBytes;
        node.tokenEst += child.tokenEst;
        node.children.push(child);
      } else {
        const st = fs.statSync(p);
        const ext = path.extname(ent.name).toLowerCase();
        let tokenEst = null;
        if (isTextExt(ext) && st.size < 2_000_000){
          try {
            const content = fs.readFileSync(p, 'utf8');
            tokenEst = approxTokensFromChars(content.length);
          } catch { tokenEst = null; }
        }
        node.sizeBytes += st.size;
        node.tokenEst += tokenEst || 0;
        node.children.push({
          name: ent.name,
          path: redactPath(p),
          type: 'file',
          sizeBytes: st.size,
          tokenEst
        });
      }
    }

    node.children.sort((a,b)=>{
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return (b.tokenEst||0)-(a.tokenEst||0);
    });

    return node;
  }

  return walk(rootDir);
}

function topFilesFromTree(tree, limit=50){
  const out = [];
  (function walk(n){
    if (!n) return;
    if (n.type === 'file'){
      if (n.tokenEst != null) out.push({ path: n.path, tokenEst: n.tokenEst, sizeBytes: n.sizeBytes });
      return;
    }
    for (const c of (n.children||[])) walk(c);
  })(tree);
  out.sort((a,b)=>b.tokenEst-a.tokenEst);
  return out.slice(0,limit);
}

function aggregateUsageSessions(){
  const daysSet = lastNDaysSet(WINDOW_DAYS);
  const sessionsRoot = path.join(OPENCLAW_DIR, 'agents');
  const sessionFiles = listFilesRecursive(sessionsRoot, {
    exts: ['.jsonl'],
    skipDirs: ['node_modules', '.git'],
    include: (p)=>p.includes(`${path.sep}sessions${path.sep}`)
  });

  const byDayModel = {};
  const byDayAgent = {};

  for (const file of sessionFiles){
    let events;
    try { events = readJsonLines(file); } catch { continue; }

    const parts = file.split(path.sep);
    const idx = parts.lastIndexOf('agents');
    const agent = idx>=0 ? parts[idx+1] : 'unknown';

    for (const evt of events){
      if (evt?.type !== 'message') continue;
      const usage = evt?.usage || evt?.message?.usage;
      const model = evt?.model || evt?.message?.model || 'unknown';
      const total = usage?.totalTokens || 0;
      if (!total) continue;

      const day = isoDate(evt.timestamp);
      if (!day || !daysSet.has(day)) continue;

      byDayModel[day] ||= {};
      byDayModel[day][model] = (byDayModel[day][model]||0)+total;

      byDayAgent[day] ||= {};
      byDayAgent[day][agent] = (byDayAgent[day][agent]||0)+total;
    }
  }

  return { byDayModel, byDayAgent };
}

function aggregateUsageCron(){
  const daysSet = lastNDaysSet(WINDOW_DAYS);
  const runsRoot = path.join(OPENCLAW_DIR, 'cron', 'runs');
  const byDayJob = {};

  if (!exists(runsRoot)) return { byDayJob };
  const runFiles = listFilesRecursive(runsRoot, { exts: ['.jsonl'] });

  for (const file of runFiles){
    const jobId = path.basename(file).replace(/\.jsonl$/, '');
    let events;
    try { events = readJsonLines(file); } catch { continue; }
    for (const evt of events){
      const usage = evt?.usage || evt?.message?.usage;
      const total = usage?.totalTokens || 0;
      if (!total) continue;
      const day = isoDate(evt?.timestamp || evt?.ts);
      if (!day || !daysSet.has(day)) continue;

      byDayJob[day] ||= {};
      byDayJob[day][jobId] = (byDayJob[day][jobId]||0)+total;
    }
  }

  return { byDayJob };
}

function writeJson(rel, obj){
  const outPath = path.join(OUT_DIR, rel);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2));
}

function main(){
  ensureDir(OUT_DIR);
  ensureDir(TREE_DIR);

  const usage = aggregateUsageSessions();
  const cron = aggregateUsageCron();

  // Workspace roots
  let roots = [];
  let workspaces;
  try { workspaces = fs.readdirSync(WORKSPACES_DIR, { withFileTypes: true }); } catch { workspaces = []; }

  for (const ent of workspaces){
    if (!ent.isDirectory()) continue;
    const rootId = ent.name;
    const abs = path.join(WORKSPACES_DIR, ent.name);
    const tree = buildWorkspaceTree(abs);
    writeJson(`workspace_tree/${rootId}.json`, tree);
    roots.push({
      id: rootId,
      name: ent.name,
      path: redactPath(abs),
      sizeBytes: tree.sizeBytes,
      tokenEst: tree.tokenEst
    });
  }

  roots.sort((a,b)=>(b.tokenEst||0)-(a.tokenEst||0));

  // Top files across all workspaces: compute from root trees without keeping mega-tree in memory
  // We'll approximate by reading each root tree file back and extracting top files.
  let topFiles = [];
  for (const r of roots){
    const treePath = path.join(TREE_DIR, `${r.id}.json`);
    try {
      const tree = JSON.parse(fs.readFileSync(treePath,'utf8'));
      topFiles = topFiles.concat(topFilesFromTree(tree, 100));
    } catch {}
  }
  topFiles.sort((a,b)=>b.tokenEst-a.tokenEst);
  topFiles = topFiles.slice(0,50);

  writeJson('meta.json', {
    version: 2,
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    redaction: { mode: 'publish-ish', note: 'Absolute paths redacted; no contents exported.' },
    estimators: { fileTokens: 'chars/4 heuristic' }
  });

  writeJson('models_daily_5d.json', usage.byDayModel);
  writeJson('agents_daily_5d.json', usage.byDayAgent);
  writeJson('cron_daily_5d.json', cron.byDayJob);
  writeJson('top_files_50.json', topFiles);
  writeJson('workspace_roots.json', roots);

  console.log('Wrote v2 data files to:', OUT_DIR);
}

main();
