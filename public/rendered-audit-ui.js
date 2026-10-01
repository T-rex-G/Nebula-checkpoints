'use strict';
(function () {
  const mounts = new WeakMap();
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => { const node = el('button', text, 'btn btn-ghost'); node.type = 'button'; node.addEventListener('click', action); return node; };
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const imageUrl = shot => shot && shot.mimeType === 'image/jpeg' && typeof shot.data === 'string' && shot.data.length < 2200000 && /^[A-Za-z0-9+/=]+$/.test(shot.data) ? `data:image/jpeg;base64,${shot.data}` : '';
  function reportHtml(result) {
    const shots = (result.viewports || []).map(view => `<figure><figcaption>${escape(view.name)} · ${escape(view.width)} × ${escape(view.height)}</figcaption>${imageUrl(view.screenshot) ? `<img alt="${escape(view.name)} viewport capture" src="${imageUrl(view.screenshot)}">` : '<p>Screenshot unavailable</p>'}<pre>${escape(JSON.stringify(view.facts, null, 2))}</pre></figure>`).join('');
    const findings = (result.findings || []).map(item => `<li><strong>${escape(item.severity)} · ${escape(item.viewport)} · ${escape(item.title)}</strong><p>${escape(item.detail)}</p></li>`).join('');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Nebulaverse rendered website audit</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172238;background:#f8fafc}img{max-width:100%;height:auto;border:1px solid #bac6d6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}li{margin:16px 0}figure{margin:28px 0}</style><h1>Rendered website audit</h1><p>${escape(result.url)} · ${escape(result.checkedAt)}</p><p>Coverage: ${escape(result.coverage && result.coverage.state)}</p><ul>${(result.coverage && result.coverage.reasons || []).map(reason => `<li>${escape(reason)}</li>`).join('')}</ul><h2>Findings</h2><ul>${findings || '<li>No automated issues observed within this sample.</li>'}</ul><h2>Viewport evidence</h2>${shots}<h2>Scope and limitations</h2><ul>${(result.limitations || []).map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></html>`;
  }
  function mount(root, { api, download }) {
    if (!root || mounts.has(root)) return;
    root.hidden = false;
    const model = { disposed: false, busy: false, run: '', url: '', result: null, cancelled: false, available: false, version: 0 };
    mounts.set(root, model);
    const heading = el('h3', 'Rendered experience');
    const intro = el('p', 'See desktop and mobile evidence for accessibility, responsive layout, search metadata and page timing.', 'rendered-intro');
    const note = el('p', 'One anonymous page. Cross-origin resources are blocked; keyboard behavior and visual design still need human review.', 'rendered-intro');
    const form = el('form', undefined, 'rendered-form');
    const label = el('label', 'Page address');
    const input = el('input');
    input.id = 'renderedAuditUrl'; input.type = 'url'; input.required = true; input.placeholder = 'https://example.com/page'; input.maxLength = 2048;
    label.htmlFor = input.id;
    const start = button('Run rendered audit', () => {}); start.className = 'btn btn-primary'; start.type = 'submit'; start.disabled = true;
    const cancel = button('Cancel audit', () => void cancelRun()); cancel.hidden = true;
    const refresh = button('Check availability', () => void readiness());
    const status = el('p', 'Checking browser availability…', 'rendered-status'); status.setAttribute('role', 'status');
    const output = el('div', undefined, 'rendered-output');
    const actions = el('div', undefined, 'rendered-actions'); actions.append(start, cancel, refresh);
    form.append(label, input, actions);
    root.replaceChildren(heading, intro, note, form, status, output);
    const endpoint = () => `/api/site-rendered?${new URLSearchParams({ url: model.url, run: model.run })}`;
    const controls = () => { start.disabled = model.busy || !model.available; input.disabled = model.busy; cancel.hidden = !model.busy; refresh.hidden = model.busy; };
    async function readiness() {
      try {
        const state = await api('/api/site-rendered/status');
        if (model.disposed) return;
        model.available = state.available === true;
        status.textContent = state.message || (model.available ? 'Ready.' : 'Rendered audits are unavailable.');
      } catch { if (!model.disposed) status.textContent = 'Browser availability could not be checked. Try again.'; }
      if (!model.disposed) controls();
    }
    async function cancelRun() {
      model.cancelled = true;
      status.textContent = 'Cancelling audit…';
      cancel.disabled = true;
      if (!model.run) return; // POST response supplies the identity-bound run to cancel.
      try { await api(endpoint(), { method: 'DELETE' }); } catch { /* A completed/expired job needs no cancellation. */ }
      if (!model.disposed) { status.textContent = 'Audit cancelled.'; model.busy = false; controls(); }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (model.busy || !model.available) return;
      const version = ++model.version;
      const current = () => !model.disposed && version === model.version;
      model.busy = true; model.cancelled = false; model.run = ''; model.url = input.value.trim(); model.result = null;
      cancel.disabled = false; controls(); output.replaceChildren(); status.textContent = 'Starting isolated browser…';
      try {
        let answer = await api('/api/site-rendered', { method: 'POST', body: { url: model.url } });
        if (!current()) return;
        model.run = answer.run || '';
        if (model.cancelled) { await cancelRun(); return; }
        const deadline = Date.now() + 115000;
        while (answer.state === 'running') {
          if (Date.now() > deadline) { await cancelRun(); throw new Error('The audit took too long. Try again.'); }
          status.textContent = `Checking ${String(answer.stage || 'page').replace(/-/g, ' ')}…`;
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!current() || model.cancelled) return;
          answer = await api(endpoint());
          if (!current() || model.cancelled) return;
        }
        if (!answer.coverage || !Array.isArray(answer.viewports)) throw new Error('The audit returned an incomplete report. Try again.');
        model.result = answer;
        status.textContent = `${answer.coverage.complete ? 'Automated checks finished' : 'Partial report'} · ${(answer.findings || []).length} observations. Review coverage and evidence below.`;
        renderResult(answer);
      } catch (error) { if (current() && !model.cancelled) status.textContent = error.message || 'The audit could not finish. Try again.'; }
      finally { if (current()) { model.busy = false; controls(); } }
    });
    function renderResult(result) {
      const downloads = el('div', undefined, 'rendered-actions');
      const filename = `website-rendered-${String(result.checkedAt || '').slice(0, 10)}`;
      downloads.append(button('Export HTML report', () => download(`${filename}.html`, reportHtml(result), 'text/html')),
        button('Export JSON evidence', () => download(`${filename}.json`, JSON.stringify(result, null, 2), 'application/json')));
      output.append(downloads, el('h4', 'Coverage and scope'));
      const reasons = el('ul');
      for (const reason of [...result.coverage.reasons, ...result.limitations]) reasons.append(el('li', reason));
      output.append(reasons);
      const grid = el('div', undefined, 'rendered-grid');
      for (const viewport of result.viewports) {
        const card = el('figure', undefined, 'rendered-viewport');
        card.append(el('figcaption', `${viewport.name} · ${viewport.width} × ${viewport.height}`));
        const source = imageUrl(viewport.screenshot);
        if (source) { const image = el('img'); image.src = source; image.alt = `${viewport.name} viewport capture of the audited page`; image.loading = 'lazy'; card.append(image); }
        else card.append(el('p', 'Screenshot unavailable.'));
        const metrics = viewport.facts && viewport.facts.metrics || {};
        const list = el('dl', undefined, 'rendered-metrics');
        for (const [title, value] of [['LCP (lab)', metrics.lcpMs == null ? 'Unavailable' : `${metrics.lcpMs} ms`], ['CLS (sample)', metrics.cls == null ? 'Unavailable' : metrics.cls], ['Horizontal overflow', `${viewport.facts.overflowPx} px`]]) {
          list.append(el('dt', title), el('dd', value));
        }
        card.append(list); grid.append(card);
      }
      output.append(grid, el('h4', 'Actionable observations'));
      const list = el('ul', undefined, 'rendered-findings');
      for (const finding of result.findings || []) {
        const item = el('li');
        item.append(el('strong', `${finding.severity} · ${finding.viewport} · ${finding.title}`), el('p', finding.detail));
        if (finding.targets) item.append(el('code', finding.targets.map(target => target.join(' → ')).join(', ')));
        list.append(item);
      }
      if (!list.children.length) list.append(el('li', 'No automated issues observed within this sample. The manual checks above remain necessary.'));
      output.append(list);
    }
    void readiness();
  }
  function dispose(root) { const model = root && mounts.get(root); if (model) model.disposed = true; if (root) { mounts.delete(root); root.replaceChildren(); root.hidden = true; } }
  window.NebulaRenderedAudit = Object.freeze({ mount, dispose, reportHtml });
})();
