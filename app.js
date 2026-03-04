async function loadJSON(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return await res.json();
}

function formatInt(n){
  return (n ?? 0).toLocaleString('en-US');
}

function objEntriesSortedByValueDesc(obj){
  return Object.entries(obj || {}).sort((a,b)=>(b[1]||0)-(a[1]||0));
}

function renderMatrix(container, byDayThenKey, { titleKeyLabel='Key', valueLabel='Tokens' } = {}){
  const days = Object.keys(byDayThenKey || {}).sort();
  const allKeys = new Set();
  for(const d of days){
    for(const k of Object.keys(byDayThenKey[d] || {})) allKeys.add(k);
  }
  const keys = [...allKeys].sort();

  // totals for sorting keys
  const totals = {};
  for(const k of keys){
    totals[k] = days.reduce((acc,d)=>acc + (byDayThenKey[d]?.[k]||0), 0);
  }
  keys.sort((a,b)=> (totals[b]||0)-(totals[a]||0));

  const grandMax = Math.max(1, ...keys.map(k=>totals[k]||0));

  let html = `<table><thead><tr><th>${titleKeyLabel}</th>`;
  for(const d of days) html += `<th>${d.slice(5)}</th>`;
  html += `<th>Total</th></tr></thead><tbody>`;

  for(const k of keys.slice(0, 12)){
    html += `<tr><td><code>${escapeHtml(k)}</code></td>`;
    for(const d of days){
      html += `<td>${formatInt(byDayThenKey[d]?.[k]||0)}</td>`;
    }
    const total = totals[k]||0;
    const pct = Math.round((total/grandMax)*100);
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

function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function buildTree(node, onSelect){
  const el = document.createElement('div');
  el.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.innerHTML = `
    <span class="icon">${node.type === 'dir' ? '📁' : '📄'}</span>
    <span>${escapeHtml(node.name)}</span>
    <span class="badge">${node.type === 'dir' ? `${formatInt(node.tokenEst||0)} tok est` : `${formatInt(node.tokenEst||0)} tok est`}</span>
  `;
  row.onclick = () => onSelect(node);
  el.appendChild(row);

  if(node.type === 'dir' && node.children && node.children.length){
    const childrenWrap = document.createElement('div');
    childrenWrap.style.marginLeft = '10px';
    // default collapsed beyond first 40 for performance
    const max = 60;
    const kids = node.children.slice(0, max);
    for(const c of kids){
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
    if(node.charCount != null) lines.push(`<div><span style="color:#aab6cc">Chars:</span> ${formatInt(node.charCount)}</div>`);
    if(node.tokenEst != null) lines.push(`<div><span style="color:#aab6cc">Token estimate if loaded:</span> ${formatInt(node.tokenEst)}</div>`);
  } else {
    lines.push(`<div style="margin-top:6px"><span style="color:#aab6cc">Total size:</span> ${formatInt(node.sizeBytes)} bytes</div>`);
    lines.push(`<div><span style="color:#aab6cc">Total token estimate:</span> ${formatInt(node.tokenEst||0)}</div>`);
    lines.push(`<div><span style="color:#aab6cc">Children:</span> ${formatInt((node.children||[]).length)}</div>`);
  }
  container.innerHTML = lines.join('');
}

(async function main(){
  document.getElementById('refreshBtn').onclick = () => location.reload();

  const dashboard = await loadJSON('./data/dashboard.json');
  document.getElementById('generatedAt').textContent = `Generated: ${dashboard.generatedAt} · Window: ${dashboard.windowDays}d · Root: ${dashboard.context.root}`;

  renderMatrix(document.getElementById('byModel'), dashboard.usage.byDayModel, { titleKeyLabel: 'Model' });
  renderMatrix(document.getElementById('byAgent'), dashboard.usage.byDayAgent, { titleKeyLabel: 'Agent' });

  // Cron by job (total last 5d)
  const cronTotals = {};
  for(const [day, jobs] of Object.entries(dashboard.cron.byDayJob || {})){
    for(const [jobId, tok] of Object.entries(jobs || {})){
      cronTotals[jobId] = (cronTotals[jobId]||0) + tok;
    }
  }
  const cronRows = objEntriesSortedByValueDesc(cronTotals).slice(0, 20).map(([jobId, tokens]) => ({ jobId, tokens }));
  renderListTable(document.getElementById('cronByJob'), cronRows, [
    { label: 'jobId', key: 'jobId', render: r => `<code>${escapeHtml(r.jobId)}</code>` },
    { label: 'tokens (5d)', key: 'tokens', render: r => formatInt(r.tokens) }
  ]);

  const topFiles = (dashboard.context.topFiles || []).slice(0, 20);
  renderListTable(document.getElementById('topFiles'), topFiles, [
    { label: 'path', key: 'path', render: r => `<code>${escapeHtml(r.path)}</code>` },
    { label: 'tok est', key: 'tokenEst', render: r => formatInt(r.tokenEst) },
    { label: 'bytes', key: 'sizeBytes', render: r => formatInt(r.sizeBytes) }
  ]);

  // Tree
  const treeRoot = dashboard.context.tree;
  const treeEl = document.getElementById('tree');
  const detailEl = document.getElementById('detail');
  treeEl.appendChild(buildTree(treeRoot, (node) => renderDetail(detailEl, node)));
})();
