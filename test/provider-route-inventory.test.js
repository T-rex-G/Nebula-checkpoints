'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const routeModuleSources = fs.readdirSync(path.join(root, 'src', 'routes'))
  .filter(name => name.endsWith('.js'))
  .map(name => fs.readFileSync(path.join(root, 'src', 'routes', name), 'utf8'));
const capabilityDocument = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'public-alpha-capabilities.json'), 'utf8')
);

const reviewedExemptions = Object.freeze({
  'GET /api/accounts': 'Local session account inventory; no repository provider transport.',
  'POST /api/accounts/switch-idx': 'Local active-session account selection.',
  'POST /api/accounts/remove': 'Local session account removal.',
  'POST /api/accounts/switch': 'Account credential validation precedes repository capability context.',
  'POST /api/github-app/connect': 'GitHub App account authorization bootstrap, not repository feature transport.',
  'GET /api/github-app/status': 'Local GitHub App configuration and session status.',
  'POST /api/github-app/refresh': 'GitHub App account credential refresh, not repository feature transport.',
  'POST /api/github-app/disconnect': 'Local GitHub App session-account removal.',
  'GET /api/security/csrf': 'Local authenticated security-context projection.',
  'POST /api/security/step-up': 'Local authenticated step-up grant creation.',
  'POST /api/logout': 'Local authenticated session termination.',
  'POST /api/alpha/providers/disconnect-all': 'Owned alpha credential-lifecycle cleanup, independent of repository feature capability.',
  'POST /api/alpha/delete': 'Owned alpha deletion lifecycle after verified provider cleanup.',
  'GET /api/me': 'Provider identity bootstrap required before repository capability projection.',
  'GET /api/workspace/posture': 'Workspace posture: the session credential\'s own kind, scopes and expiry, and this identity\'s persisted recovery and exposure summaries.',
  'GET /api/safety': 'Local repository-scoped safety-state read.',
  'POST /api/safety': 'Local repository-scoped safety-state update.',
  'GET /api/security/sessions': 'Local authenticated session inventory.',
  'POST /api/security/revoke-others': 'Local authenticated session revocation.'
});

function skipQuoted(source, index, quote) {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) return cursor;
  }
  throw new Error(`Unterminated ${quote} string at offset ${index} while reading server routes`);
}

function skipComment(source, index) {
  if (source[index + 1] === '/') {
    const end = source.indexOf('\n', index + 2);
    return end === -1 ? source.length - 1 : end;
  }
  if (source[index + 1] === '*') {
    const end = source.indexOf('*/', index + 2);
    if (end === -1) throw new Error('Unterminated block comment while reading server routes');
    return end + 1;
  }
  return index;
}

function startsRegex(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0 || /[([{,:;=!?&|+\-*%^~<>]/.test(source[cursor])) return true;
  const before = source.slice(Math.max(0, cursor - 12), cursor + 1);
  return /\b(?:return|case|throw|typeof|instanceof|yield|await)$/.test(before);
}

function skipRegex(source, index) {
  let inClass = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === '[') inClass = true;
    else if (source[cursor] === ']') inClass = false;
    else if (source[cursor] === '/' && !inClass) {
      while (/[a-z]/i.test(source[cursor + 1] || '')) cursor += 1;
      return cursor;
    }
  }
  throw new Error(`Unterminated regular expression at offset ${index} while reading server routes`);
}

function routeCallEnd(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (char === '/' && startsRegex(source, index)) {
      index = skipRegex(source, index);
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return index;
  }
  throw new Error('Unterminated Express route registration');
}

function splitTopLevelArguments(source) {
  const args = [];
  let start = 0;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (char === '/' && startsRegex(source, index)) {
      index = skipRegex(source, index);
      continue;
    }
    if (char === '(') parens += 1;
    else if (char === ')') parens -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === ',' && parens === 0 && brackets === 0 && braces === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(source.slice(start).trim());
  return args;
}

function authenticatedRoutes(source) {
  const routes = [];
  const routeStart = /\bapp\.(get|post|put|patch|delete)\s*\(/g;
  let match;
  while ((match = routeStart.exec(source))) {
    const open = source.indexOf('(', match.index);
    const end = routeCallEnd(source, open);
    const args = splitTopLevelArguments(source.slice(open + 1, end));
    routeStart.lastIndex = end + 1;
    const pathMatch = args[0] && args[0].match(/^(['"])([^'"]+)\1$/);
    if (!pathMatch || !pathMatch[2].startsWith('/api/')) continue;
    const authType = args.find(arg => (
      arg === 'auth'
      || arg === 'accountAuth'
      || arg === 'alphaDeletionAuthentication'
    ));
    if (!authType) continue;
    /* Every capability a route names, including one it checks only when a request asks for it. */
    const features = args
      .map(arg => arg.match(/^capabilityAccess(?:When)?\s*\(\s*(['"])([a-z][a-z0-9.-]+)\1/))
      .filter(Boolean)
      .map(found => found[2]);
    routes.push({
      method: match[1].toUpperCase(),
      path: pathMatch[2],
      authType,
      feature: features[0] || null,
      features
    });
  }
  return routes;
}

function validateInventory(source) {
  const routes = authenticatedRoutes(source);
  const routeKeys = new Set(routes.map(route => `${route.method} ${route.path}`));
  assert.strictEqual(routeKeys.size, routes.length, 'authenticated route inventory contains duplicate method/path entries');

  const unclassified = routes
    .filter(route => !route.feature && !reviewedExemptions[`${route.method} ${route.path}`])
    .map(route => `${route.method} ${route.path}`)
    .sort();
  assert.deepStrictEqual(
    unclassified,
    [],
    `Authenticated routes need capabilityAccess or a reviewed exemption: ${unclassified.join(', ')}`
  );

  const staleExemptions = Object.keys(reviewedExemptions)
    .filter(key => !routeKeys.has(key))
    .sort();
  assert.deepStrictEqual(staleExemptions, [], `Reviewed route exemptions are stale: ${staleExemptions.join(', ')}`);

  for (const route of routes.filter(entry => entry.feature)) {
    for (const provider of ['github']) {
      const features = capabilityDocument.providers?.[provider]?.['hosted-alpha'] || {};
      assert(
        Object.prototype.hasOwnProperty.call(features, route.feature),
        `${route.method} ${route.path} maps ${provider} to implicit default capability ${route.feature}`
      );
    }
  }
  return routes;
}

const routes = validateInventory(serverSource);
for (const [key, feature] of Object.entries({
  'GET /api/rate': 'rate.read',
  'GET /api/repo/:owner/:repo/commits': 'repository.read',
  'GET /api/repo/:owner/:repo/commit/:sha': 'repository.read',
  'GET /api/repo/:owner/:repo/intelligence/events': 'governance',
  'GET /api/repo/:owner/:repo/evidence': 'governance'
})) {
  const route = routes.find(entry => `${entry.method} ${entry.path}` === key);
  assert(route, `missing authenticated provider route ${key}`);
  assert.strictEqual(route.feature, feature, `${key} must consult ${feature} before provider transport`);
}

/* Branch reads name branches.read, and an explicit Git LFS upload is checked at the route before its body is read. */
for (const [key, feature] of Object.entries({
  'GET /api/repo/:owner/:repo': 'branches.read',
  'GET /api/repo/:owner/:repo/files': 'branches.read',
  'GET /api/repo/:owner/:repo/branch-protection': 'branches.read',
  'GET /api/repo/:owner/:repo/refs-snapshot': 'branches.read',
  'POST /api/repo/:owner/:repo/emergency-manifest': 'branches.read',
  'POST /api/repo/:owner/:repo/governance/baselines/generate': 'branches.read',
  'POST /api/repo/:owner/:repo/upload': 'lfs'
})) {
  const route = routes.find(entry => `${entry.method} ${entry.path}` === key);
  assert(route, `missing authenticated provider route ${key}`);
  assert(route.features.includes(feature), `${key} must name ${feature}`);
}

/* Every capability the registry offers is named by at least one route, so none is offered without a gate. */
const allNamed = new Set(routes.flatMap(route => route.features));
for (const moduleSource of routeModuleSources) {
  for (const found of moduleSource.matchAll(/capabilityAccess(?:When)?\s*\(\s*(['"])([a-z][a-z0-9.-]+)\1/g)) allNamed.add(found[2]);
}
const unnamed = Object.keys(capabilityDocument.providers.github['hosted-alpha']).filter(feature => !allNamed.has(feature)).sort();
assert.deepStrictEqual(unnamed, [], `registry capabilities no route names: ${unnamed.join(', ')}`);

/* No route can accept what is not Supported: the experimental opt-in does not exist. */
for (const [name, source] of [['server.js', serverSource], ...routeModuleSources.map((source, index) => [`src/routes #${index}`, source])]) {
  assert(!/allowExperimental/.test(source), `${name} must not carry an experimental opt-in`);
}

assert.throws(
  () => validateInventory(`${serverSource}
app.get('/api/repo/:owner/:repo/new-provider-read', auth, async (req, res) => {
  res.json(await gh(req.gh, R(req)));
});
`),
  /new-provider-read/,
  'a newly added authenticated provider route must fail until it is classified'
);

console.log('provider route inventory tests passed');
