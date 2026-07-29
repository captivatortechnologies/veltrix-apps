// Render a dataflow model as a self-contained interactive page.
//
//   renderBody(model)       -> style + markup + script fragment (no doc wrapper).
//                              Used for the Claude artifact preview.
//   renderStandalone(model) -> full HTML document. Used for the GitHub Pages file.
//   renderIndex(models)     -> catalog page linking every app's dataflow page.
//
// The template is data-driven: the model is embedded as JSON and the same markup +
// script renders any app, so all 33 pages share one template at rollout.

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const jsonForScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c')

const STYLE = `<style>
  :root{
    --bg:#f6f8fc; --surface:#ffffff; --surface-2:#f1f5f9; --border:#e2e8f0;
    --text:#0f172a; --muted:#64748b; --faint:#94a3b8;
    --brand:#2563eb; --brand-soft:#dbeafe;
    --deploy:#0ea5e9; --drift:#f59e0b; --rollback:#8b5cf6; --ok:#10b981;
    --vendor:#ef4444; --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px -12px rgba(15,23,42,.18);
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0a0f1c; --surface:#111a2e; --surface-2:#0f1728; --border:#1e293b;
      --text:#e6edf6; --muted:#94a3b8; --faint:#64748b;
      --brand:#60a5fa; --brand-soft:#172554; --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -14px rgba(0,0,0,.6);
    }
  }
  :root[data-theme="dark"]{
    --bg:#0a0f1c; --surface:#111a2e; --surface-2:#0f1728; --border:#1e293b;
    --text:#e6edf6; --muted:#94a3b8; --faint:#64748b; --brand:#60a5fa; --brand-soft:#172554;
    --shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -14px rgba(0,0,0,.6);
  }
  :root[data-theme="light"]{
    --bg:#f6f8fc; --surface:#ffffff; --surface-2:#f1f5f9; --border:#e2e8f0;
    --text:#0f172a; --muted:#64748b; --faint:#94a3b8; --brand:#2563eb; --brand-soft:#dbeafe;
    --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px -12px rgba(15,23,42,.18);
  }
  *{box-sizing:border-box}
  .df{font-family:var(--sans);color:var(--text);background:var(--bg);
    line-height:1.5;-webkit-font-smoothing:antialiased;padding:clamp(16px,3vw,40px);
    max-width:1180px;margin:0 auto}
  .df h1,.df h2,.df h3,.df p{margin:0}
  .df a{color:var(--brand);text-decoration:none}
  .df a:hover{text-decoration:underline}
  .mono{font-family:var(--mono);font-size:.85em}
  .num{font-variant-numeric:tabular-nums}

  /* header */
  .hd{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-bottom:22px}
  .hd .icon{font-size:34px;line-height:1;filter:saturate(1.1)}
  .hd .who h1{font-size:clamp(20px,2.6vw,28px);font-weight:700;letter-spacing:-.02em;text-wrap:balance}
  .hd .who .sub{color:var(--muted);font-size:14px;margin-top:3px}
  .hd .who .desc{color:var(--muted);font-size:13.5px;margin-top:8px;max-width:64ch}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-left:auto}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;
    padding:9px 13px;min-width:74px;box-shadow:var(--shadow)}
  .stat .n{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums}
  .stat .l{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin-top:1px}

  /* toolbar */
  .toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
  .seg{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:3px}
  .seg button{font-family:inherit;font-size:12.5px;font-weight:600;color:var(--muted);
    background:none;border:0;border-radius:7px;padding:6px 12px;cursor:pointer;display:flex;gap:6px;align-items:center}
  .seg button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:var(--shadow)}
  .seg .dot{width:8px;height:8px;border-radius:50%}
  .dot.deploy{background:var(--deploy)} .dot.drift{background:var(--drift)}
  .search{flex:1;min-width:180px;position:relative}
  .search input{width:100%;font-family:inherit;font-size:13.5px;color:var(--text);
    background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 12px 9px 32px}
  .search input:focus{outline:2px solid var(--brand);outline-offset:1px;border-color:transparent}
  .search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--faint)}

  .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
  .chip{font-family:inherit;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;
    background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:5px 12px;display:flex;gap:7px;align-items:center}
  .chip:hover{border-color:var(--brand)}
  .chip[aria-pressed="true"]{background:var(--brand);border-color:var(--brand);color:#fff}
  .chip .c{font-variant-numeric:tabular-nums;opacity:.75;font-size:11px}
  .chip[aria-pressed="true"] .c{opacity:.9}

  /* diagram lanes */
  .flow{display:grid;grid-template-columns:minmax(160px,1fr) 46px minmax(160px,1fr) 46px minmax(220px,1.5fr);
    gap:0;align-items:stretch;margin-bottom:8px}
  @media (max-width:820px){.flow{grid-template-columns:1fr;gap:8px}.gutter{height:40px;width:100%}}
  .lane{display:flex;flex-direction:column;gap:10px}
  .lane .cap{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);font-weight:700;margin-bottom:2px}
  .node{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px;box-shadow:var(--shadow)}
  .node .t{font-weight:650;font-size:14px}
  .node .d{font-size:11.5px;color:var(--muted);margin-top:3px}
  .node.app{border-color:var(--brand);background:linear-gradient(180deg,var(--brand-soft),var(--surface))}
  .node.seam{border-style:dashed}
  .pipe .steps{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
  .pipe .step{font-size:10.5px;font-weight:600;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:3px 7px;color:var(--muted)}

  .gutter{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px;position:relative}
  .arrow{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:9.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);transition:opacity .18s}
  .arrow .line{width:2px;height:26px}
  .arrow.deploy .line{background:linear-gradient(var(--deploy),var(--deploy))}
  .arrow.drift .line{background:linear-gradient(var(--drift),var(--drift))}
  .arrow.deploy{color:var(--deploy)} .arrow.drift{color:var(--drift)}
  .arrow .g{font-size:13px;line-height:1}
  @media (max-width:820px){.gutter{flex-direction:row}.arrow{flex-direction:row}.arrow .line{width:26px;height:2px}}
  .flow[data-dir="deploy"] .arrow.drift,.flow[data-dir="drift"] .arrow.deploy{opacity:.18}

  /* vendor families */
  .fam{display:grid;grid-template-columns:1fr;gap:8px}
  .famcard{width:100%;text-align:left;font-family:inherit;cursor:pointer;background:var(--surface);
    border:1px solid var(--border);border-left:3px solid var(--vendor);border-radius:10px;padding:10px 12px;
    box-shadow:var(--shadow);transition:transform .12s,border-color .12s,opacity .15s}
  .famcard:hover{transform:translateX(2px)}
  .famcard:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
  .famcard .row{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .famcard .nm{font-weight:650;font-size:13px}
  .famcard .ct{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .famcard .meter{display:flex;gap:2px;margin-top:8px}
  .famcard .meter i{height:4px;border-radius:2px;flex:1}
  .famcard .meter i.on{background:var(--deploy)} .famcard .meter i.dr{background:var(--drift)} .famcard .meter i.off{background:var(--border)}
  .famcard[aria-selected="true"]{border-color:var(--vendor);box-shadow:0 0 0 2px var(--vendor)}
  .flow.has-sel .famcard:not([aria-selected="true"]){opacity:.4}

  /* detail */
  .detail{background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow);
    padding:16px 18px;margin-top:16px;min-height:120px}
  .detail .dh{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}
  .detail .dh h3{font-size:15px;font-weight:700}
  .detail .dh .meta{font-size:12px;color:var(--muted)}
  .empty{color:var(--muted);font-size:13.5px}
  table.types{width:100%;border-collapse:collapse;font-size:13px}
  table.types th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);font-weight:700;padding:0 8px 8px;border-bottom:1px solid var(--border)}
  table.types td{padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:top}
  table.types tr:last-child td{border-bottom:0}
  .tname{font-weight:600} .tid{color:var(--muted)} .tdesc{color:var(--muted);font-size:11.5px;margin-top:2px;max-width:52ch}
  .badges{display:flex;gap:5px;flex-wrap:wrap}
  .badge{font-size:10px;font-weight:700;border-radius:6px;padding:2px 7px;letter-spacing:.02em;white-space:nowrap}
  .badge.deploy{background:color-mix(in srgb,var(--deploy) 16%,transparent);color:var(--deploy)}
  .badge.drift{background:color-mix(in srgb,var(--drift) 18%,transparent);color:var(--drift)}
  .badge.rollback{background:color-mix(in srgb,var(--rollback) 16%,transparent);color:var(--rollback)}
  .badge.status{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
  .foot{margin-top:22px;font-size:12px;color:var(--faint);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .legend{display:flex;gap:14px;flex-wrap:wrap}
  .legend span{display:flex;gap:5px;align-items:center}
  .legend i{width:9px;height:9px;border-radius:3px;display:inline-block}
</style>`

const MARKUP = `<div class="df">
  <header class="hd">
    <div class="icon" id="df-icon"></div>
    <div class="who">
      <h1 id="df-name"></h1>
      <div class="sub" id="df-sub"></div>
      <p class="desc" id="df-desc"></p>
    </div>
    <div class="stats" id="df-stats"></div>
  </header>

  <div class="toolbar">
    <div class="seg" role="group" aria-label="Direction">
      <button data-dir="both" aria-pressed="true">Both</button>
      <button data-dir="deploy" aria-pressed="false"><span class="dot deploy"></span>Deploy ▶</button>
      <button data-dir="drift" aria-pressed="false"><span class="dot drift"></span>Drift ◀</button>
    </div>
    <label class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      <input id="df-search" type="search" placeholder="Search config types…" autocomplete="off">
    </label>
  </div>

  <div class="chips" id="df-chips"></div>

  <div class="flow" id="df-flow" data-dir="both">
    <div class="lane" id="lane-platform">
      <span class="cap">Veltrix Platform</span>
      <div class="node"><div class="t">Config Canvas</div><div class="d">Author config as code</div></div>
      <div class="node pipe"><div class="t">Pipeline</div><div class="steps"><span class="step">validate</span><span class="step">deploy</span><span class="step">drift</span><span class="step">rollback</span></div></div>
      <div class="node seam" id="node-vault" hidden><div class="t">Credential Vault</div><div class="d">resolveConnection</div></div>
      <div class="node seam" id="node-remote" hidden><div class="t">Network / ZTNA</div><div class="d">ctx.remote</div></div>
    </div>
    <div class="gutter">
      <div class="arrow deploy"><span class="g">▶</span><div class="line"></div><span>deploy</span></div>
      <div class="arrow drift"><span>drift</span><div class="line"></div><span class="g">◀</span></div>
    </div>
    <div class="lane" id="lane-app">
      <span class="cap">App</span>
      <div class="node app"><div class="t" id="df-appname"></div><div class="d">SDK ctx · resolveConnection · remote</div></div>
      <div class="node" id="node-adapters"><div class="t">Adapters</div><div class="d mono" id="df-adapters"></div></div>
    </div>
    <div class="gutter">
      <div class="arrow deploy"><span class="g">▶</span><div class="line"></div><span>write</span></div>
      <div class="arrow drift"><span>read</span><div class="line"></div><span class="g">◀</span></div>
    </div>
    <div class="lane" id="lane-vendor">
      <span class="cap" id="df-vendorcap">Vendor APIs</span>
      <div class="fam" id="df-families"></div>
    </div>
  </div>

  <section class="detail" id="df-detail"></section>

  <div class="foot">
    <div class="legend">
      <span><i style="background:var(--deploy)"></i>deploy (write)</span>
      <span><i style="background:var(--drift)"></i>drift (read)</span>
      <span><i style="background:var(--rollback)"></i>rollback</span>
      <span><i style="background:var(--ok)"></i>status</span>
    </div>
    <div id="df-foot"></div>
  </div>
</div>`

const SCRIPT = `<script>
(function(){
  const M = JSON.parse(document.getElementById('df-model').textContent);
  const $ = (id) => document.getElementById(id);
  const vendorFamilies = M.families.filter(f => !f.isConnection);
  document.documentElement.style.setProperty('--vendor', M.primaryColor || '#ef4444');

  const state = { dir:'both', family:null, q:'' };

  // header
  $('df-icon').textContent = M.icon || '';
  $('df-name').textContent = M.name + ' — Dataflow';
  $('df-sub').innerHTML = '<span class="mono">'+M.id+'</span> · '+(M.category||'—')+' · v'+(M.version||'—')+(M.vendor?(' · by '+M.vendor):'');
  $('df-desc').textContent = M.description || '';
  $('df-appname').textContent = M.name;
  $('df-adapters').textContent = (M.adapters||[]).join(' · ') || '—';
  $('df-vendorcap').textContent = (M.name || 'Vendor') + ' APIs';
  $('df-foot').innerHTML = 'Generated from <span class="mono">manifest.yaml</span>';
  if (M.requiresCredential) $('node-vault').hidden = false;
  if (M.requiresConnectivity) $('node-remote').hidden = false;

  const c = M.counts;
  $('df-stats').innerHTML = [
    ['Config types', c.vendorTypes],['API families', c.families],
    ['Deployable', c.deployable],['Drift-detected', c.driftable],['Rollback', c.rollbackable]
  ].map(([l,n]) => '<div class="stat"><div class="n num">'+n+'</div><div class="l">'+l+'</div></div>').join('');

  // chips
  $('df-chips').innerHTML = '<button class="chip" data-fam="" aria-pressed="true">All families <span class="c">'+c.vendorTypes+'</span></button>' +
    vendorFamilies.map(f => '<button class="chip" data-fam="'+encodeURIComponent(f.name)+'" aria-pressed="false">'+escapeHtml(f.name)+' <span class="c">'+f.types.length+'</span></button>').join('');

  // family cards
  $('df-families').innerHTML = vendorFamilies.map(f => {
    const meter = f.types.map(t => '<i class="'+(t.caps.deploy?'on':t.caps.drift?'dr':'off')+'"></i>').join('');
    return '<button class="famcard" data-fam="'+encodeURIComponent(f.name)+'" aria-selected="false">'+
      '<div class="row"><span class="nm">'+escapeHtml(f.name)+'</span><span class="ct num">'+f.deployable+'▶ / '+f.driftable+'◀</span></div>'+
      '<div class="meter">'+meter+'</div></button>';
  }).join('');

  function typeMatches(t){
    if(!state.q) return true;
    const q = state.q.toLowerCase();
    return t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q) || (t.description||'').toLowerCase().includes(q);
  }
  function badges(t){
    const b=[];
    if(t.caps.deploy) b.push('<span class="badge deploy">deploy</span>');
    if(t.caps.drift) b.push('<span class="badge drift">drift</span>');
    if(t.caps.rollback) b.push('<span class="badge rollback">rollback</span>');
    if(t.caps.status||t.caps.health) b.push('<span class="badge status">status</span>');
    return '<div class="badges">'+b.join('')+'</div>';
  }
  function typeRows(types){
    return types.map(t => '<tr><td><div class="tname">'+escapeHtml(t.name)+'</div><div class="tid mono">'+t.id+'</div>'+
      (t.description?'<div class="tdesc">'+escapeHtml(t.description)+'</div>':'')+'</td><td>'+badges(t)+'</td></tr>').join('');
  }

  function renderDetail(){
    const el = $('df-detail');
    if(state.family){
      const f = vendorFamilies.find(x => x.name === state.family);
      const types = f.types.filter(typeMatches);
      el.innerHTML = '<div class="dh"><h3>'+escapeHtml(f.name)+'</h3><span class="meta">'+f.types.length+' config types · '+f.deployable+' deployable · '+f.driftable+' drift-detected</span></div>'+
        (types.length? '<table class="types"><thead><tr><th>Config type</th><th>Capabilities</th></tr></thead><tbody>'+typeRows(types)+'</tbody></table>'
          : '<p class="empty">No config types match “'+escapeHtml(state.q)+'”.</p>');
    } else if(state.q){
      const hits = vendorFamilies.flatMap(f => f.types.filter(typeMatches).map(t => [f,t]));
      el.innerHTML = '<div class="dh"><h3>Search</h3><span class="meta">'+hits.length+' match'+(hits.length===1?'':'es')+' for “'+escapeHtml(state.q)+'”</span></div>'+
        (hits.length? '<table class="types"><thead><tr><th>Config type</th><th>Capabilities</th></tr></thead><tbody>'+
          hits.map(([f,t]) => '<tr><td><div class="tname">'+escapeHtml(t.name)+'</div><div class="tid mono">'+f.name+' · '+t.id+'</div></td><td>'+badges(t)+'</td></tr>').join('')+'</tbody></table>'
          : '<p class="empty">No config types match.</p>');
    } else {
      el.innerHTML = '<p class="empty">Select an API family (or search) to see its config types and how each one flows.</p>';
    }
  }

  function apply(){
    $('df-flow').setAttribute('data-dir', state.dir);
    $('df-flow').classList.toggle('has-sel', !!state.family);
    document.querySelectorAll('.famcard').forEach(el => el.setAttribute('aria-selected', String(decodeURIComponent(el.dataset.fam)===state.family)));
    document.querySelectorAll('.chip').forEach(el => {
      const fam = el.dataset.fam ? decodeURIComponent(el.dataset.fam) : null;
      el.setAttribute('aria-pressed', String(fam===state.family));
    });
    document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dir===state.dir)));
    renderDetail();
  }

  function selectFamily(name){ state.family = (state.family===name?null:name); apply(); }

  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => { state.dir=b.dataset.dir; apply(); }));
  document.querySelectorAll('.famcard').forEach(el => el.addEventListener('click', () => selectFamily(decodeURIComponent(el.dataset.fam))));
  document.querySelectorAll('.chip').forEach(el => el.addEventListener('click', () => { state.family = el.dataset.fam? decodeURIComponent(el.dataset.fam):null; apply(); }));
  $('df-search').addEventListener('input', (e) => { state.q = e.target.value.trim(); renderDetail(); });

  function escapeHtml(s){return String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  apply();
})();
</script>`

export function renderBody(model) {
  const data = `<script type="application/json" id="df-model">${jsonForScript(model)}</script>`
  return `${STYLE}\n${MARKUP}\n${data}\n${SCRIPT}\n`
}

export function renderStandalone(model) {
  const title = `${model.name} — Dataflow`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Dataflow for the ${esc(model.name)} Veltrix app — how config flows between the platform, the app, and the ${esc(model.name)} APIs.">
<style>body{margin:0;background:#f6f8fc}@media(prefers-color-scheme:dark){body{background:#0a0f1c}}</style>
</head>
<body>
${renderBody(model)}
</body>
</html>
`
}

export function renderIndex(models) {
  const cards = models
    .map(
      (m) =>
        `<a class="card" href="./${esc(m.id)}.html"><span class="ic">${esc(m.icon || '📦')}</span>` +
        `<span class="nm">${esc(m.name)}</span><span class="meta">${esc(m.category || '')} · ${m.counts.vendorTypes} types · ${m.counts.families} families</span></a>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Veltrix Apps — Dataflow Catalog</title>
<style>
  :root{--bg:#f6f8fc;--surface:#fff;--border:#e2e8f0;--text:#0f172a;--muted:#64748b;--brand:#2563eb}
  @media(prefers-color-scheme:dark){:root{--bg:#0a0f1c;--surface:#111a2e;--border:#1e293b;--text:#e6edf6;--muted:#94a3b8;--brand:#60a5fa}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:clamp(20px,4vw,56px)}
  .wrap{max-width:1080px;margin:0 auto}
  h1{font-size:clamp(22px,3vw,30px);letter-spacing:-.02em;margin:0 0 6px}
  p.sub{color:var(--muted);margin:0 0 28px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .card{display:flex;flex-direction:column;gap:4px;background:var(--surface);border:1px solid var(--border);
    border-radius:14px;padding:16px;text-decoration:none;color:inherit;box-shadow:0 8px 24px -14px rgba(15,23,42,.2);transition:transform .12s,border-color .12s}
  .card:hover{transform:translateY(-2px);border-color:var(--brand)}
  .ic{font-size:26px} .nm{font-weight:650;font-size:15px} .meta{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div class="wrap">
  <h1>Veltrix Apps — Dataflow Catalog</h1>
  <p class="sub">${models.length} apps. Each page shows how configuration flows between the Veltrix platform, the app, and the vendor APIs.</p>
  <div class="grid">
${cards}
  </div>
</div>
</body>
</html>
`
}
