async function loadJSON(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return await res.json();
}

function formatInt(n){ return (n ?? 0).toLocaleString('en-US'); }

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function renderMatrix(container, byDayThenKey, titleKeyLabel){
  const days = Object.keys(byDayThenKey || {}).sort();
  const keysSet = new Set();
  for(const d of days){
    for(const k of Object.keys(byDayThenKey[d]||{})) keysSet.add(k);
  }
  let keys = [...keysSet];
  const totals = {};
  for(const k of keys){
    totals[k] = days.reduce((acc,d)=>acc + (byDayThenKey[d]?.[k]||0), 0);
  }
  keys.sort((a,b)=>(totals[b]||0)-(totals[a]||0));
  const max = Math.max(1, ...keys.map(k=>totals[k]||0));

  let html = `<table><thead><tr><th>${titleKeyLabel}</th>`;
  for(const d of days) html += `<th>${d.slice(5)}</th>`;
  html += `<th>Total</th></tr></thead><tbody>`;

  for(const k of keys.slice(0, 12)){
    html += `<tr><td><code>${escapeHtml(k)}</code></td>`;
    for(const d of days) html += `<td>${formatInt(byDayThenKey[d]?.[k]||0)}</td>`;
    const total = totals[k]||0;
    const pct = Math.round((total/max)*100);
    html += `<td><div style="display:flex;gap:8px;align-items:center"><span>${formatInt(total)}</span><div class="bar" style="flex:1"><span style="width:${pct}%"></span></div></div></td></tr>`;
  }

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function renderListTable(container, rows, columns){
  let html = `<table><thead><tr>`;
  for(const c of columns) html += `<th>${c.label}</th>`;
  html += `</tr></thead><tbody>`;
  for(const r of rows){
    html += `<tr>`;
    for(const c of columns){
      const v = c.render ? c.render(r) : r[c.key];
      html += `<td>${v}</td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  container.innerHTML = html;
}

function buildTree(node, onSelect){
  const el = document.createElement('div');
  el.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.innerHTML = `
    <span class="icon">${node.type === 'dir' ? '📁' : '📄'}</span>
    <span>${escapeHtml(node.name)}</span>
    <span class="badge">${formatInt(node.tokenEst||0)} tok est</span>
  `;
  row.onclick = () => onSelect(node);
  el.appendChild(row);

  if(node.type === 'dir' && node.children && node.children.length){
    const childrenWrap = document.createElement('div');
    childrenWrap.style.marginLeft = '10px';
    const max = 80;
    for(const c of node.children.slice(0, max)){
      childrenWrap.appendChild(buildTree(c, onSelect));
    }
    if(node.children.length > max){
      const more = document.createElement('div');
      more.className = 'tree-row';
      more.style.color = '#aab6cc';
      more.textContent = `… ${node.children.length - max} more`;
      childrenWrap.appendChild(more);
    }
    el.appendChild(childrenWrap);
  }

  return el;
}

function renderDetail(container, node){
  const lines = [];
  lines.push(`<div><strong>${escapeHtml(node.name)}</strong> <span style="color:#aab6cc">(${node.type})</span></div>`);
  lines.push(`<div style="margin-top:6px"><span style="color:#aab6cc">Path:</span> <code>${escapeHtml(node.path)}</code></div>`);
  if(node.type === 'file'){
    lines.push(`<div style="margin-top:6px"><span style="color:#aab6cc">Size:</span> ${formatInt(node.sizeBytes)} bytes</div>`);
    if(node.tokenEst != null) lines.push(`<div><span style="color:#aab6cc">Token estimate if loaded:</span> ${formatInt(node.tokenEst)}</div>`);
  } else {
    lines.push(`<div style="margin-top:6px"><span style="color:#aab6cc">Total size:</span> ${formatInt(node.sizeBytes)} bytes</div>`);
    lines.push(`<div><span style="color:#aab6cc">Total token estimate:</span> ${formatInt(node.tokenEst||0)}</div>`);
    lines.push(`<div><span style="color:#aab6cc">Children:</span> ${formatInt((node.children||[]).length)}</div>`);
  }
  container.innerHTML = lines.join('');
}

async function main(){
  document.getElementById('refreshBtn').onclick = () => location.reload();

  const meta = await loadJSON('./data/meta.json');
  document.getElementById('generatedAt').textContent = `Generated: ${meta.generatedAt} · Window: ${meta.windowDays}d · Redaction: ${meta.redaction.mode}`;

  const [byModel, byAgent, cronByDay, topFiles, roots] = await Promise.all([
    loadJSON('./data/models_daily_5d.json'),
    loadJSON('./data/agents_daily_5d.json'),
    loadJSON('./data/cron_daily_5d.json'),
    loadJSON('./data/top_files_50.json'),
    loadJSON('./data/workspace_roots.json')
  ]);

  renderMatrix(document.getElementById('byModel'), byModel, 'Model');
  renderMatrix(document.getElementById('byAgent'), byAgent, 'Agent');

  // Cron totals
  const cronTotals = {};
  for(const [day, jobs] of Object.entries(cronByDay||{})){
    for(const [jobId, tok] of Object.entries(jobs||{})){
      cronTotals[jobId] = (cronTotals[jobId]||0) + tok;
    }
  }
  const cronRows = Object.entries(cronTotals).sort((a,b)=>b[1]-a[1]).slice(0,20)
    .map(([jobId,tokens])=>({jobId,tokens}));
  renderListTable(document.getElementById('cronByJob'), cronRows, [
    { label: 'jobId', key: 'jobId', render: r => `<code>${escapeHtml(r.jobId)}</code>` },
    { label: 'tokens (5d)', key: 'tokens', render: r => formatInt(r.tokens) }
  ]);

  renderListTable(document.getElementById('topFiles'), topFiles.slice(0,20), [
    { label: 'path', key: 'path', render: r => `<code>${escapeHtml(r.path)}</code>` },
    { label: 'tok est', key: 'tokenEst', render: r => formatInt(r.tokenEst) },
    { label: 'bytes', key: 'sizeBytes', render: r => formatInt(r.sizeBytes) }
  ]);

  // Explorer: roots list -> load tree on click
  const treeEl = document.getElementById('tree');
  const detailEl = document.getElementById('detail');

  const rootsCard = document.createElement('div');
  rootsCard.className = 'card';
  rootsCard.style.marginBottom = '10px';
  rootsCard.innerHTML = `<h3 style="margin:0 0 8px 0;font-size:13px">Workspace roots</h3>`;
  const rootsTable = document.createElement('div');
  rootsCard.appendChild(rootsTable);

  renderListTable(rootsTable, roots.slice(0,50), [
    { label: 'workspace', key: 'name', render: r => `<a href="#" data-root="${escapeHtml(r.id)}"><code>${escapeHtml(r.name)}</code></a>` },
    { label: 'tok est', key: 'tokenEst', render: r => formatInt(r.tokenEst) },
    { label: 'bytes', key: 'sizeBytes', render: r => formatInt(r.sizeBytes) }
  ]);

  treeEl.appendChild(rootsCard);

  treeEl.addEventListener('click', async (e) => {
    const a = e.target.closest('a[data-root]');
    if (!a) return;
    e.preventDefault();
    const rootId = a.getAttribute('data-root');

    detailEl.textContent = `Loading ${rootId}…`;
    // remove previous loaded tree if exists
    const existing = treeEl.querySelector('div[data-loaded-tree="1"]');
    if (existing) existing.remove();

    const tree = await loadJSON(`./data/workspace_tree/${rootId}.json`);
    const wrap = document.createElement('div');
    wrap.setAttribute('data-loaded-tree','1');
    wrap.appendChild(buildTree(tree, (node)=>renderDetail(detailEl,node)));
    treeEl.appendChild(wrap);
    renderDetail(detailEl, tree);
  });
}

main();
