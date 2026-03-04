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
  data/session_boot_5d.json
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

function estimateSessionBootCosts(){
  // Use activity.jsonl / command:new timestamps, then find first assistant usage after that timestamp
  const daysSet = lastNDaysSet(WINDOW_DAYS);
  const activityPath = path.join(OPENCLAW_DIR, 'activity.jsonl');
  if (!exists(activityPath)) return { events: [], stats: {} };

  const activity = readJsonLines(activityPath);
  const newCmds = activity.filter(e => e?.type === 'command' && e?.action === 'new' && e?.status === 'success');

  // Pre-index session files by agent (and by agent+topic when present)
  const sessionsRoot = path.join(OPENCLAW_DIR, 'agents');
  const sessionFiles = listFilesRecursive(sessionsRoot, {
    exts: ['.jsonl'],
    skipDirs: ['node_modules', '.git'],
    include: (p)=>p.includes(`${path.sep}sessions${path.sep}`)
  });

  const byAgent = new Map();      // agent -> [files]
  const byAgentTopic = new Map(); // agent|topic -> [files]

  for (const f of sessionFiles){
    const parts = f.split(path.sep);
    const ai = parts.lastIndexOf('agents');
    const agent = ai>=0 ? parts[ai+1] : 'unknown';

    const arrA = byAgent.get(agent) || [];
    arrA.push(f);
    byAgent.set(agent, arrA);

    const m = f.match(/topic-(\d+)\.jsonl/);
    const topic = m ? m[1] : null;
    if (topic){
      const key = `${agent}|${topic}`;
      const arrT = byAgentTopic.get(key) || [];
      arrT.push(f);
      byAgentTopic.set(key, arrT);
    }
  }

  function sortNewestFirst(arr){
    arr.sort((a,b)=>{
      try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
    });
  }
  for (const arr of byAgent.values()) sortNewestFirst(arr);
  for (const arr of byAgentTopic.values()) sortNewestFirst(arr);

  const results = [];

  const diag = {
    newCommandsInWindow: 0,
    mapped: 0,
    noCandidateFiles: 0,
    noAssistantAfter: 0
  };

  for (const cmd of newCmds){
    const day = isoDate(cmd.ts);
    if (!day || !daysSet.has(day)) continue;
    diag.newCommandsInWindow += 1;

    const sessionKey = cmd.sessionKey || '';
    const agentMatch = sessionKey.match(/^agent:([^:]+)/);
    const agent = agentMatch ? agentMatch[1] : 'unknown';
    const topicMatch = sessionKey.match(/topic:(\d+)/);
    const topic = topicMatch ? topicMatch[1] : null;

    const cmdTime = new Date(cmd.ts).getTime();

    // Prefer agent+topic, else fall back to all sessions for that agent
    const files = topic
      ? (byAgentTopic.get(`${agent}|${topic}`) || byAgent.get(agent) || [])
      : (byAgent.get(agent) || []);

    if (!files.length){
      diag.noCandidateFiles += 1;
      continue;
    }

    // Find first assistant message after cmd.ts across candidate files (newest-first)
    let boot = null;
    for (const candidate of files){
      let events;
      try { events = readJsonLines(candidate); } catch { continue; }

      for (const evt of events){
        if (evt?.type !== 'message') continue;
        const role = evt?.message?.role;
        if (role !== 'assistant') continue;
        const t = new Date(evt.timestamp).getTime();
        if (Number.isNaN(t)) continue;
        if (t < cmdTime) continue;
        const usage = evt?.usage || evt?.message?.usage;
        const total = usage?.totalTokens || 0;
        if (!total) continue;
        const model = evt?.model || evt?.message?.model || 'unknown';
        boot = { totalTokens: total, model };
        break;
      }
      if (boot) break;
    }

    if (!boot){
      diag.noAssistantAfter += 1;
      continue;
    }

    diag.mapped += 1;
    results.push({
      day,
      agent,
      topic: topic ? Number(topic) : null,
      sessionKey,
      commandAtMs: cmd.ts,
      model: boot.model,
      bootTokens: boot.totalTokens
    });
  }

  // stats: by model p50/p90
  function quantile(arr, q){
    if (!arr.length) return null;
    const a = [...arr].sort((x,y)=>x-y);
    const pos = (a.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    return a[base+1] !== undefined ? a[base] + rest*(a[base+1]-a[base]) : a[base];
  }

  const byModel = {};
  for (const r of results){
    byModel[r.model] ||= [];
    byModel[r.model].push(r.bootTokens);
  }

  const statsByModel = {};
  for (const [m, arr] of Object.entries(byModel)){
    statsByModel[m] = {
      count: arr.length,
      p50: Math.round(quantile(arr, 0.5) || 0),
      p90: Math.round(quantile(arr, 0.9) || 0)
    };
  }

  const all = results.map(r=>r.bootTokens);
  const stats = {
    count: all.length,
    p50: Math.round(quantile(all, 0.5) || 0),
    p90: Math.round(quantile(all, 0.9) || 0),
    byModel: statsByModel
  };

  return { events: results, stats, diagnostics: diag };
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

  const boot = estimateSessionBootCosts();

  writeJson('models_daily_5d.json', usage.byDayModel);
  writeJson('agents_daily_5d.json', usage.byDayAgent);
  writeJson('cron_daily_5d.json', cron.byDayJob);
  writeJson('top_files_50.json', topFiles);
  writeJson('session_boot_5d.json', boot);
  writeJson('workspace_roots.json', roots);

  console.log('Wrote v2 data files to:', OUT_DIR);
}

main();
