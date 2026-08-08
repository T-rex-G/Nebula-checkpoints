(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NebulaExportSafety = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function csvCell(value) {
    let text = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function activityCsv(activity = {}) {
    const rows = [['type', 'id', 'title', 'state', 'actor', 'timestamp', 'sha_or_tag', 'risk_score', 'severity']];
    for (const item of activity.commits || []) rows.push([
      'commit', item.sha || '', item.message || '', '', item.actor || item.author || '',
      item.timestamp || item.date || item.authored_at || '', item.sha || '', '', ''
    ]);
    for (const item of activity.pulls || []) rows.push([
      'pull_request', item.number || '', item.title || '', item.state || '', item.actor || item.user || item.author || '',
      item.timestamp || item.updated_at || item.updated || item.created_at || '', '', '', ''
    ]);
    for (const item of activity.issues || []) rows.push([
      'issue', item.number || '', item.title || '', item.state || '', item.actor || item.user || item.author || '',
      item.timestamp || item.updated_at || item.updated || item.created_at || '', '', '', ''
    ]);
    for (const item of activity.releases || []) rows.push([
      'release', item.id || '', item.name || item.tag || '',
      item.state || (item.draft ? 'draft' : item.prerelease ? 'prerelease' : 'published'),
      item.actor || item.author || '', item.timestamp || item.published_at || item.published || item.created_at || '',
      item.tag || '', '', ''
    ]);
    for (const item of activity.intelligenceEvents || []) rows.push([
      'verified_event', item.id || '', item.summary || `${item.eventType || 'event'} ${item.action || ''}`.trim(), item.action || '',
      item.actor || '', item.createdAt || item.timestamp || '', item.afterSha || item.beforeSha || item.ref || '',
      item.score == null ? '' : item.score, item.severity || ''
    ]);
    return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  return { csvCell, activityCsv };
});
