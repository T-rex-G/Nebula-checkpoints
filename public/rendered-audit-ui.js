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
    const shots = (result.viewports || []).map(view => `<figure><figcaption>${escape(view.name)} · ${escape(view.width)} × ${escape(view.height)}</figcaption><p>Final page: ${escape(view.finalUrl || result.url)}</p>${imageUrl(view.screenshot) ? `<img alt="${escape(view.name)} viewport capture" src="${imageUrl(view.screenshot)}">` : '<p>Screenshot unavailable</p>'}<pre>${escape(JSON.stringify(view.facts, null, 2))}</pre></figure>`).join('');
    const findings = (result.findings || []).map(item => `<li><strong>${escape(item.severity)} · ${escape(item.viewport)} · ${escape(item.title)}</strong><p>${escape(item.detail)}</p></li>`).join('');
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Nebulaverse rendered website audit</title><style>body{font:16px/1.6 system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172238;background:#f8fafc}img{max-width:100%;height:auto;border:1px solid #bac6d6}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}li{margin:16px 0}figure{margin:28px 0}</style><h1>Rendered website audit</h1><p>${escape(result.url)} · ${escape(result.checkedAt)}</p><p>Coverage: ${escape(result.coverage && result.coverage.state)}</p><ul>${(result.coverage && result.coverage.reasons || []).map(reason => `<li>${escape(reason)}</li>`).join('')}</ul><h2>Findings</h2><ul>${findings || '<li>No automated issues observed within this sample.</li>'}</ul><h2>Viewport evidence</h2>${shots}<h2>Scope and limitations</h2><ul>${(result.limitations || []).map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></html>`;
  }
  function mount(root, { api, download }) {
    if (!root || mounts.has(root)) return;
    root.hidden = false;
    const model = { disposed: false, busy: false, run: '', url: '', result: null, cancelled: false, available: false, version: 0 };
    mounts.set(root, model);
    /* The same card as "Check a site" above it: a mark and a title, one field
       with its action beside it, and the limits said once, small, below. */
    root.classList.add('card', 'audit-site');
    root.setAttribute('aria-labelledby', 'renderedAuditHeading');
    const head = el('div', undefined, 'audit-site-head');
    const mark = el('span', undefined, 'audit-site-mark');
    mark.innerHTML = '<svg class="ico" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="14" height="10.5" rx="1.6"/><path d="M6.5 18h6M9.5 14.5V18"/><rect x="16.5" y="9" width="5" height="10" rx="1.2"/></svg>';
    const titles = el('div', undefined, 'audit-site-titles');
    const heading = el('h2', 'Rendered experience', 'exposure-heading');
    heading.id = 'renderedAuditHeading';
    titles.append(heading, el('p', 'Desktop and mobile evidence from one anonymous page in an isolated browser: accessibility, responsive layout, search metadata and timing.', 'audit-site-lede'));
    head.append(mark, titles);
    const form = el('form', undefined, 'audit-site-form');
    form.noValidate = true;
    const label = el('label', 'Page address', 'audit-site-label');
    const field = el('div', undefined, 'audit-site-field');
    const input = el('input', undefined, 'audit-site-input');
    input.id = 'renderedAuditUrl'; input.type = 'url'; input.inputMode = 'url'; input.spellcheck = false; input.placeholder = 'https://example.com/page'; input.maxLength = 2048;
    label.htmlFor = input.id;
    const start = button('Run rendered audit', () => {}); start.className = 'btn btn-primary'; start.type = 'submit'; start.disabled = true;
    field.append(input, start);
    const cancel = button('Cancel audit', () => void cancelRun()); cancel.hidden = true; cancel.classList.add('small');
    const refresh = button('Check availability', () => void readiness()); refresh.classList.add('small');
    const status = el('p', 'Checking browser availability…', 'rendered-status'); status.setAttribute('role', 'status');
    const output = el('div', undefined, 'rendered-output');
    const actions = el('div', undefined, 'rendered-actions'); actions.append(status, cancel, refresh);
    form.append(label, field, el('p', 'Cross-origin resources are blocked, and nothing is clicked or submitted. Keyboard behaviour and visual design still need a person.', 'audit-site-hint'));
    root.replaceChildren(head, form, actions, output);
    const endpoint = () => `/api/site-rendered?${new URLSearchParams({ run: model.run })}`;
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
      try { await api(endpoint(), { method: 'DELETE' }); } catch (error) {
        if (error.status !== 404) {
          if (!model.disposed) { status.textContent = 'Cancellation could not be confirmed. Try cancelling again.'; cancel.disabled = false; }
          return;
        }
      }
      model.run = '';
      if (!model.disposed) { status.textContent = 'Audit cancelled.'; model.busy = false; controls(); }
    }
    model.stop = cancelRun;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (model.busy || !model.available) return;
      const version = ++model.version;
      const current = () => !model.disposed && version === model.version;
      model.busy = true; model.cancelled = false; model.run = ''; model.url = input.value.trim(); model.result = null;
      cancel.disabled = false; controls(); output.replaceChildren(); status.textContent = 'Starting isolated browser…';
      try {
        let answer = await api('/api/site-rendered', { method: 'POST', body: { url: model.url } });
        model.run = answer.run || '';
        if (!current()) { await cancelRun(); return; }
        if (model.cancelled) { await cancelRun(); return; }
        const deadline = Date.now() + 115000;
        let pollFailures = 0;
        while (answer.state === 'running') {
          if (Date.now() > deadline) { await cancelRun(); throw new Error('The audit took too long. Try again.'); }
          status.textContent = `Checking ${String(answer.stage || 'page').replace(/-/g, ' ')}…`;
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!current() || model.cancelled) return;
          try { answer = await api(endpoint()); pollFailures = 0; }
          catch (error) {
            if (++pollFailures <= 3 && (!error.status || [429, 502, 503, 504].includes(error.status))) continue;
            throw error;
          }
          if (!current() || model.cancelled) return;
        }
        if (!answer.coverage || !Array.isArray(answer.viewports)) throw new Error('The audit returned an incomplete report. Try again.');
        model.result = answer;
        status.textContent = `${answer.coverage.complete ? 'Automated checks finished' : 'Partial report'} · ${(answer.findings || []).length} observations. Review coverage and evidence below.`;
        renderResult(answer);
      } catch (error) {
        if (model.run) { try { await api(endpoint(), { method: 'DELETE' }); } catch { /* The bounded worker still expires if connectivity was lost. */ } }
        if (current() && !model.cancelled) status.textContent = error.message || 'The audit could not finish. Try again.';
      }
      finally { if (current()) { model.busy = Boolean(model.cancelled && model.run); controls(); } }
    });
    function renderResult(result) {
      const downloads = el('div', undefined, 'rendered-actions');
      const filename = `website-rendered-${String(result.checkedAt || '').slice(0, 10)}`;
      downloads.append(button('Export HTML report', () => download(`${filename}.html`, reportHtml(result), 'text/html')),
        button('Export JSON evidence', () => download(`${filename}.json`, JSON.stringify(result, null, 2), 'application/json')));
      output.append(el('p', `Audited page: ${result.url}`), downloads, el('h4', 'Coverage and scope'));
      const reasons = el('ul');
      for (const reason of [...result.coverage.reasons, ...result.limitations]) reasons.append(el('li', reason));
      output.append(reasons);
      const grid = el('div', undefined, 'rendered-grid');
      for (const viewport of result.viewports) {
        const card = el('figure', undefined, 'rendered-viewport');
        card.append(el('figcaption', `${viewport.name} · ${viewport.width} × ${viewport.height}`));
        if (viewport.finalUrl) card.append(el('p', `Final page: ${viewport.finalUrl}`));
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
  function dispose(root) { const model = root && mounts.get(root); if (model) { model.disposed = true; if (model.busy && model.stop) void model.stop(); } if (root) { mounts.delete(root); root.replaceChildren(); root.hidden = true; } }
  window.NebulaRenderedAudit = Object.freeze({ mount, dispose, reportHtml });
})();
