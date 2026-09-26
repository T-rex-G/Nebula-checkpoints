/*
 * The repository audit, drawn.
 *
 * The order is the argument, as it is on the Exposure screen: the grade and
 * how much of the repository it rests on come first, then the four families
 * it was built from, then the findings. A findings list alone invites the
 * reading "nothing here, so nothing is wrong", which a partial read does not
 * support.
 *
 * Everything is built with textContent. The audit's words are the rules' own
 * and paths come from a repository, and neither is ever parsed as markup.
 */
'use strict';

(function codeAuditModule(global) {
  const SEVERITY = Object.freeze({
    critical: Object.freeze({ glyph: '✕', word: 'Critical' }),
    serious: Object.freeze({ glyph: '△', word: 'Serious' }),
    warning: Object.freeze({ glyph: '○', word: 'Warning' })
  });
  const STORE_PREFIX = 'nv_audit:';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, className, onClick) {
    const node = element('button', className, label);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }
  function plural(count, one, many) {
    return `${count} ${count === 1 ? one : many}`;
  }
  function location(finding) {
    if (!finding.path) return 'Whole repository';
    return finding.line ? `${finding.path}:${finding.line}` : finding.path;
  }

  /*
   * What changed since this browser last audited the same repository: which
   * findings are new, and how many earlier ones are gone. Identities only --
   * the stored record is a list of fingerprints and a time, nothing a
   * repository wrote -- and the account-boundary purge removes it.
   */
  function diff(result, previous) {
    if (!previous || !Array.isArray(previous.ids)) return null;
    const before = new Set(previous.ids);
    const now = new Set(result.findings.map(finding => finding.id));
    return {
      previousAt: previous.at || null,
      newIds: new Set([...now].filter(id => !before.has(id))),
      resolved: [...before].filter(id => !now.has(id)).length
    };
  }
  function storageKey(repoKey) {
    return `${STORE_PREFIX}${String(repoKey || '').toLowerCase()}`;
  }
  function readPrevious(repoKey) {
    try { return JSON.parse(global.localStorage.getItem(storageKey(repoKey)) || 'null'); } catch { return null; }
  }
  function remember(repoKey, result) {
    try {
      global.localStorage.setItem(storageKey(repoKey), JSON.stringify({
        at: result.auditedAt || new Date().toISOString(),
        ids: result.findings.map(finding => finding.id).slice(0, 2000)
      }));
    } catch { /* private mode: no comparison next time, and nothing is lost */ }
  }

  function coverageLine(result) {
    const coverage = result.coverage || {};
    const parts = [`Read ${coverage.read} of ${coverage.eligible} files it audits at ${String(result.commitSha || '').slice(0, 7)}`];
    const packages = coverage.packages || {};
    if (packages.declared) {
      parts.push(`${packages.checked} of ${packages.declared} packages checked against their registry` +
        (packages.unknown ? ` (${packages.unknown} unanswered, not counted as missing)` : ''));
    }
    return `${parts.join(' · ')}.`;
  }
  function coverageCaveat(result) {
    const coverage = result.coverage || {};
    const notes = [];
    if (coverage.treeTruncated) notes.push('the provider truncated the file listing');
    if (coverage.skipped && coverage.skipped.budget) notes.push(`${plural(coverage.skipped.budget, 'file', 'files')} beyond the audit budget were not read`);
    if (coverage.skipped && coverage.skipped.oversize) notes.push(`${plural(coverage.skipped.oversize, 'file', 'files')} over 512 KB were not read`);
    if (coverage.unreadable) notes.push(`${plural(coverage.unreadable, 'file', 'files')} could not be read`);
    if (coverage.packages && coverage.packages.notChecked) notes.push(`${plural(coverage.packages.notChecked, 'package', 'packages')} beyond the lookup limit were not checked`);
    return notes.length ? `Not a complete read: ${notes.join('; ')}. A finding-free section here is not a finding-free repository.` : '';
  }

  function renderSummary(host, view, handlers) {
    const card = element('section', 'card audit-summary');
    card.setAttribute('aria-labelledby', 'auditSummaryHeading');
    const heading = element('h2', 'exposure-heading', 'What this audit found');
    heading.id = 'auditSummaryHeading';
    card.appendChild(heading);

    const result = view.result;
    const row = element('div', 'audit-grade-row');
    const grade = element('div', `audit-grade audit-grade-${result ? result.grade : 'none'}`);
    grade.setAttribute('role', 'img');
    grade.setAttribute('aria-label', result ? `Grade ${result.grade}, ${result.score} out of 100` : 'Not audited');
    grade.append(element('span', 'audit-grade-letter', result ? result.grade : '—'),
      element('span', 'audit-grade-score', result ? `${result.score}/100` : 'not audited'));
    row.appendChild(grade);

    const read = element('div', 'audit-grade-read');
    if (view.status === 'running') {
      read.appendChild(element('p', 'audit-lede', 'Reading the branch and checking its packages…'));
    } else if (view.status === 'error') {
      const error = element('p', 'audit-lede audit-error', view.error || 'The audit could not be completed.');
      error.setAttribute('role', 'alert');
      read.appendChild(error);
    } else if (!result) {
      read.appendChild(element('p', 'audit-lede', 'Audit this branch for install-time code, workflows that hand CI secrets to strangers, injection and cross-site scripting sinks, secrets shipped to browsers, unsigned webhooks, invented packages and project hygiene.'));
    } else {
      const total = result.findings.length;
      read.appendChild(element('p', 'audit-lede', total
        ? `${plural(total, 'finding', 'findings')}: ${['critical', 'serious', 'warning'].map(severity => {
          const count = result.findings.filter(finding => finding.severity === severity).length;
          return count ? `${count} ${severity}` : '';
        }).filter(Boolean).join(', ')}.`
        : 'No findings in what was read.'));
      if (result.capped) read.appendChild(element('p', 'audit-cap', 'Held below 50 while a critical finding is open.'));
      read.appendChild(element('p', 'audit-coverage', coverageLine(result)));
      const caveat = coverageCaveat(result);
      if (caveat) read.appendChild(element('p', 'exposure-caveat', caveat));
      if (view.diff) {
        const since = view.diff.previousAt ? ` since the audit of ${new Date(view.diff.previousAt).toLocaleString()}` : '';
        read.appendChild(element('p', 'audit-diff',
          `${plural(view.diff.newIds.size, 'new finding', 'new findings')}, ${view.diff.resolved} resolved${since}.`));
      }
    }
    row.appendChild(read);
    card.appendChild(row);

    const actions = element('div', 'exposure-actions');
    const run = button(view.status === 'running' ? 'Auditing…' : result ? 'Audit again' : 'Audit this branch', 'btn btn-primary', handlers.onRun);
    run.disabled = view.status === 'running';
    actions.appendChild(run);
    if (result) {
      actions.appendChild(button('Export developer brief', 'btn btn-ghost', handlers.onExport));
      if (result.findings.length) actions.appendChild(button('Copy all fix prompts', 'btn btn-ghost', handlers.onCopyAll));
    }
    card.appendChild(actions);
    host.appendChild(card);
  }

  function renderCategories(host, view, handlers) {
    const result = view.result;
    if (!result) return;
    const list = element('ul', 'audit-categories');
    list.setAttribute('aria-label', 'Audit families');
    for (const category of result.categories) {
      const item = element('li', 'audit-category');
      const control = button('', 'audit-category-btn', () => handlers.onFilter(view.filter === category.id ? null : category.id));
      control.setAttribute('aria-pressed', view.filter === category.id ? 'true' : 'false');
      const status = category.counts.critical ? 'critical' : category.counts.serious ? 'serious' : category.counts.warning ? 'warning' : 'clear';
      control.dataset.status = status;
      control.append(
        element('span', 'audit-category-label', category.label),
        element('span', 'audit-category-score', `${category.score}`),
        element('span', 'audit-category-counts', status === 'clear'
          ? 'Nothing found'
          : ['critical', 'serious', 'warning'].filter(severity => category.counts[severity])
            .map(severity => `${SEVERITY[severity].glyph} ${category.counts[severity]} ${severity}`).join('  '))
      );
      const meter = element('span', 'audit-category-meter');
      meter.setAttribute('aria-hidden', 'true');
      meter.style.setProperty('--audit-fill', `${category.score}%`);
      control.appendChild(meter);
      item.appendChild(control);
      list.appendChild(item);
    }
    host.appendChild(list);
  }

  /*
   * One finding, opened into its reason, its fix and a prompt. A repository
   * finding's place opens the file; a site finding's place is a header or a
   * path on the site, and is shown, not followed.
   */
  function findingList(findings, changes, handlers) {
    const list = element('ul', 'exposure-list audit-list');
    for (const finding of findings) {
      const item = element('li', 'exposure-item audit-item');
      item.dataset.severity = finding.severity;
      const details = element('details', 'audit-details');
      const summary = element('summary', 'audit-summary-row');
      const pill = element('span', `audit-pill audit-pill-${finding.severity}`);
      pill.append(element('span', 'audit-pill-glyph', SEVERITY[finding.severity].glyph), element('span', null, SEVERITY[finding.severity].word));
      summary.append(pill, element('span', 'exposure-item-title', finding.title));
      if (changes && changes.newIds.has(finding.id)) summary.appendChild(element('span', 'audit-new', 'New'));
      details.appendChild(summary);

      const body = element('div', 'audit-body');
      const where = element('p', 'exposure-item-where');
      where.appendChild(element('span', 'audit-rule', finding.rule));
      if (finding.path && handlers.onOpen) {
        const open = button(location(finding), 'audit-location', () => handlers.onOpen(finding));
        open.setAttribute('aria-label', `Open ${location(finding)}`);
        where.appendChild(open);
      } else {
        where.appendChild(element('span', 'audit-location-static', finding.where || location(finding)));
      }
      body.appendChild(where);
      body.appendChild(element('p', 'exposure-item-consequence', finding.why));
      const fix = element('p', 'exposure-item-action');
      fix.append(element('strong', null, 'Fix: '), document.createTextNode(finding.fix));
      body.appendChild(fix);
      body.appendChild(button('Copy fix prompt', 'btn btn-ghost small', event => handlers.onCopy(finding, event.currentTarget)));
      details.appendChild(body);
      item.appendChild(details);
      list.appendChild(item);
    }
    return list;
  }

  function renderFindings(host, view, handlers) {
    const result = view.result;
    if (!result) return;
    const card = element('section', 'card exposure-findings audit-findings');
    card.setAttribute('aria-labelledby', 'auditFindingsHeading');
    const head = element('div', 'exposure-section-head');
    const title = element('h2', 'exposure-heading', view.filter
      ? `Findings — ${result.categories.find(category => category.id === view.filter).label}`
      : 'Findings');
    title.id = 'auditFindingsHeading';
    head.appendChild(title);
    if (view.filter) head.appendChild(button('Show all', 'btn btn-ghost small', () => handlers.onFilter(null)));
    card.appendChild(head);

    const shown = result.findings.filter(finding => !view.filter || finding.category === view.filter);
    if (!shown.length) {
      card.appendChild(element('p', 'exposure-empty', view.filter ? 'Nothing found in this family, in what was read.' : 'Nothing found, in what was read.'));
      host.appendChild(card);
      return;
    }
    card.appendChild(findingList(shown, view.diff, handlers));
    host.appendChild(card);
  }

  /* Where the provider has no repository reader, the audit says so rather than showing an empty -- and therefore clean -- result. */
  function renderUnavailable(host, reason) {
    const card = element('section', 'card audit-summary audit-unavailable');
    card.setAttribute('aria-labelledby', 'auditSummaryHeading');
    const heading = element('h2', 'exposure-heading', 'Repository audit');
    heading.id = 'auditSummaryHeading';
    card.append(heading,
      element('p', 'audit-lede', 'Not available for this provider yet.'),
      element('p', 'audit-coverage', reason),
      element('p', 'audit-coverage', 'The deployed-site check below does not read the repository and works here.'));
    host.appendChild(card);
  }

  const HEADER_NAMES = Object.freeze({
    'strict-transport-security': 'Strict-Transport-Security',
    'content-security-policy': 'Content-Security-Policy',
    'x-frame-options': 'X-Frame-Options',
    'x-content-type-options': 'X-Content-Type-Options',
    'referrer-policy': 'Referrer-Policy',
    'permissions-policy': 'Permissions-Policy'
  });

  /*
   * The deployed site: an address, the grade its responses earn, which of
   * the headers a browser enforces were sent, and the findings. The address
   * is the only thing typed here, and only its origin is ever requested.
   */
  function siteCoverage(result) {
    const hops = result.redirects
      ? ` after ${plural(result.redirects, 'redirect', 'redirects')}${result.requested && result.requested !== result.origin ? ` from ${result.requested}` : ''}`
      : '';
    return `${plural(result.requests, 'anonymous request', 'anonymous requests')}; the page answered ${result.status}${hops}.`;
  }

  function renderSite(host, site, handlers) {
    const card = element('section', 'card audit-site');
    card.setAttribute('aria-labelledby', 'auditSiteHeading');
    const heading = element('h2', 'exposure-heading', 'Deployed site');
    heading.id = 'auditSiteHeading';
    card.append(heading, element('p', 'audit-lede audit-site-lede',
      'The live site as any visitor’s browser sees it: the security headers it sends, its cookies, and whether it serves an environment file or its Git directory. Ten anonymous requests at most, with no credential and no cookie; nothing it reads is kept.'));

    const form = element('form', 'audit-site-form');
    form.noValidate = true;
    const label = element('label', 'audit-site-label', 'Site address');
    label.htmlFor = 'auditSiteUrl';
    const field = element('div', 'audit-site-field');
    const input = element('input', 'audit-site-input');
    input.id = 'auditSiteUrl';
    input.type = 'url';
    input.inputMode = 'url';
    input.autocomplete = 'url';
    input.spellcheck = false;
    input.placeholder = 'https://your-app.example.com';
    input.value = site.url || '';
    input.disabled = site.status === 'running';
    input.addEventListener('input', () => handlers.onSiteInput(input.value));
    const submit = element('button', 'btn btn-primary', site.status === 'running' ? 'Checking…' : site.result ? 'Check again' : 'Check site');
    submit.type = 'submit';
    submit.disabled = site.status === 'running';
    field.append(input, submit);
    form.append(label, field);
    if (site.suggested && !site.result) form.appendChild(element('p', 'audit-site-hint', 'Filled in from the repository’s homepage.'));
    form.addEventListener('submit', event => { event.preventDefault(); handlers.onSiteCheck(input.value); });
    card.appendChild(form);

    if (site.status === 'running') {
      card.appendChild(element('p', 'audit-lede', 'Requesting the page and the paths that should never be served…'));
    } else if (site.status === 'error') {
      const error = element('p', 'audit-lede audit-error', site.error || 'The site could not be checked.');
      error.setAttribute('role', 'alert');
      card.appendChild(error);
    }

    const result = site.result;
    if (result && site.status !== 'running') {
      const row = element('div', 'audit-grade-row');
      const grade = element('div', `audit-grade audit-grade-${result.grade}`);
      grade.setAttribute('role', 'img');
      grade.setAttribute('aria-label', `Site grade ${result.grade}, ${result.score} out of 100`);
      grade.append(element('span', 'audit-grade-letter', result.grade), element('span', 'audit-grade-score', `${result.score}/100`));
      const read = element('div', 'audit-grade-read');
      const total = result.findings.length;
      read.appendChild(element('p', 'audit-lede', total
        ? `${plural(total, 'finding', 'findings')} on ${result.origin}.`
        : `Nothing found on ${result.origin}.`));
      if (result.capped) read.appendChild(element('p', 'audit-cap', 'Held below 50 while a critical finding is open.'));
      read.appendChild(element('p', 'audit-coverage', siteCoverage(result)));
      if (site.diff) {
        const since = site.diff.previousAt ? ` since the check of ${new Date(site.diff.previousAt).toLocaleString()}` : '';
        read.appendChild(element('p', 'audit-diff',
          `${plural(site.diff.newIds.size, 'new finding', 'new findings')}, ${site.diff.resolved} resolved${since}.`));
      }
      row.append(grade, read);
      card.appendChild(row);

      const headers = element('ul', 'audit-headers');
      headers.setAttribute('aria-label', 'Security headers');
      for (const header of result.headers || []) {
        const item = element('li', 'audit-header');
        item.dataset.present = header.present ? 'true' : 'false';
        item.append(element('span', 'audit-header-glyph', header.present ? '✓' : '✕'),
          element('span', 'audit-header-name', HEADER_NAMES[header.name] || header.name),
          element('span', 'audit-header-state', header.present ? 'sent' : 'not sent'));
        headers.appendChild(item);
      }
      card.appendChild(headers);

      const actions = element('div', 'exposure-actions');
      if (total) actions.appendChild(button('Copy all fix prompts', 'btn btn-ghost', handlers.onSiteCopyAll));
      if (handlers.onExport && !site.hasRepositoryResult) actions.appendChild(button('Export developer brief', 'btn btn-ghost', handlers.onExport));
      if (actions.childNodes.length) card.appendChild(actions);
      if (total) card.appendChild(findingList(result.findings, site.diff, { onCopy: handlers.onCopy }));
    }
    host.appendChild(card);
  }

  function render(root, view, handlers) {
    if (!root) return;
    root.replaceChildren();
    if (view.unavailable) {
      renderUnavailable(root, view.unavailable);
    } else {
      renderSummary(root, view, handlers);
      renderCategories(root, view, handlers);
      renderFindings(root, view, handlers);
    }
    if (view.site) renderSite(root, { ...view.site, hasRepositoryResult: Boolean(view.result) }, handlers);
  }

  /*
   * The developer brief: the audit as a Markdown document a reader can hand
   * to whoever fixes it, or to an assistant. Rules, places, reasons, fixes and
   * the prompts -- the same words the screen shows, and still no code.
   */
  function findingSection(findings, lines, prefix, place) {
    findings.forEach((finding, index) => {
      lines.push(
        `## ${prefix}${index + 1}. ${finding.title}`,
        '',
        `- **Severity:** ${finding.severity}`,
        `- **Rule:** ${finding.rule}`,
        `- **Where:** ${place(finding)}`,
        '',
        finding.why,
        '',
        `**Fix.** ${finding.fix}`,
        '',
        '```text',
        finding.prompt,
        '```',
        ''
      );
    });
  }

  function brief(result, repoLabel, site) {
    const lines = [`# Security audit: ${repoLabel}`, ''];
    if (result) {
      lines.push(
        `Grade **${result.grade}** — ${result.score}/100${result.capped ? ' (held below 50 by a critical finding)' : ''}.`,
        `Commit \`${result.commitSha}\`, audited ${result.auditedAt || new Date().toISOString()}.`,
        '',
        coverageLine(result),
        coverageCaveat(result),
        '',
        '| Family | Score | Critical | Serious | Warning |',
        '| --- | --- | --- | --- | --- |',
        ...result.categories.map(category => `| ${category.label} | ${category.score} | ${category.counts.critical} | ${category.counts.serious} | ${category.counts.warning} |`),
        ''
      );
      if (!result.findings.length) lines.push('No findings in what was read.', '');
      findingSection(result.findings, lines, '', finding => finding.path ? `\`${location(finding)}\`` : 'whole repository');
    }
    if (site) {
      lines.push(
        `# Deployed site: ${site.origin}`,
        '',
        `Grade **${site.grade}** — ${site.score}/100${site.capped ? ' (held below 50 by a critical finding)' : ''}.`,
        `Checked ${site.checkedAt || new Date().toISOString()}: ${siteCoverage(site)}`,
        '',
        '| Header | Sent |',
        '| --- | --- |',
        ...(site.headers || []).map(header => `| ${HEADER_NAMES[header.name] || header.name} | ${header.present ? 'yes' : 'no'} |`),
        ''
      );
      if (!site.findings.length) lines.push('No findings on the site.', '');
      findingSection(site.findings, lines, 'S', finding => `\`${finding.where}\``);
    }
    return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
  }

  function allPrompts(result) {
    return (result ? result.findings : []).map((finding, index) => `${index + 1}. ${finding.prompt}`).join('\n\n');
  }

  global.NebulaCodeAudit = Object.freeze({ STORE_PREFIX, render, brief, allPrompts, diff, readPrevious, remember, storageKey });
})(typeof globalThis === 'undefined' ? this : globalThis);

if (typeof module === 'object' && module.exports) module.exports = globalThis.NebulaCodeAudit;
