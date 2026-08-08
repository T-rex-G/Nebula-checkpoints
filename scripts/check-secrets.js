'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const extensions = new Set(['.js', '.json', '.yaml', '.yml']);
const excluded = new Set(['node_modules', '.git', 'dist', 'playwright-report', 'test-results']);
const patterns = [
  { name: 'private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ }
];
const findings = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.startsWith('._')) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile() && (extensions.has(path.extname(entry.name)) || entry.name === '.env.example')) {
      if (entry.name === 'package-lock.json') continue;
      const text = fs.readFileSync(absolute, 'utf8');
      for (const pattern of patterns) if (pattern.regex.test(text)) findings.push(`${path.relative(root, absolute)}: ${pattern.name}`);
    }
  }
}
walk(root);
if (findings.length) {
  console.error(`Potential embedded secrets detected:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log('secret pattern check passed');
