'use strict';
const assert = require('assert');
const { csvCell, activityCsv } = require('../public/export-safety');

assert.strictEqual(csvCell('plain'), '"plain"');
assert.strictEqual(csvCell('hello,"world"'), '"hello,""world"""');
assert.strictEqual(csvCell('line1\nline2'), '"line1 line2"');
for (const dangerous of ['=1+1', '+SUM(A1:A2)', '-2+3', '@cmd', '\t=hidden', '\r+hidden']) {
  const cell = csvCell(dangerous);
  assert(cell.startsWith('"\''), `Formula-like value must be neutralized: ${JSON.stringify(dangerous)} -> ${cell}`);
}

const csv = activityCsv({
  commits: [{ sha: 'abc', message: '=HYPERLINK("https://example.invalid")', author: 'Alice', date: '2026-07-21T00:00:00Z' }],
  pulls: [{ number: 7, title: '+Danger', state: 'open', actor: 'Bob', timestamp: '2026-07-21T01:00:00Z' }],
  issues: [], releases: [],
  intelligenceEvents: [{ id: 'evt-1', summary: '@Critical', action: 'push', actor: 'Mallory', createdAt: '2026-07-21T02:00:00Z', score: 90, severity: 'critical' }]
});
assert(csv.includes('"\'=HYPERLINK(""https://example.invalid"")"'));
assert(csv.includes('"\'+Danger"'));
assert(csv.includes('"\'@Critical"'));
assert(csv.endsWith('\r\n'));
console.log('export safety tests passed');
