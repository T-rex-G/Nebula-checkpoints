'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const capabilityDocument = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'public-alpha-capabilities.json'), 'utf8')
);

function skipQuoted(source, index, quote) {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
      continue;
    }
    if (source[cursor] === quote) return cursor;
  }
  throw new Error(`Unterminated ${quote} string at offset ${index}`);
}

function skipComment(source, index) {
  if (source[index + 1] === '/') {
    const end = source.indexOf('\n', index + 2);
    return end === -1 ? source.length - 1 : end;
  }
  if (source[index + 1] === '*') {
    const end = source.indexOf('*/', index + 2);
    if (end === -1) throw new Error('Unterminated block comment');
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
  throw new Error(`Unterminated regular expression at offset ${index}`);
}

function callEnd(source, openIndex) {
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
  throw new Error('Unterminated Express registration');
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

function expressRegistrations(source) {
  const registrations = [];
  const startRx = /\bapp\.(get|post|put|patch|delete|use)\s*\(/g;
  let match;
  while ((match = startRx.exec(source))) {
    const open = source.indexOf('(', match.index);
    const end = callEnd(source, open);
    const args = splitTopLevelArguments(source.slice(open + 1, end));
    startRx.lastIndex = end + 1;
    const pathMatch = args[0] && args[0].match(/^(['"])([^'"]+)\1$/);
    registrations.push({
      method: match[1].toUpperCase(),
      path: pathMatch ? pathMatch[2] : null,
      args,
      index: match.index
    });
  }
  return registrations;
}

function validateAlphaRouteInventory(source) {
  const registrations = expressRegistrations(source);
  const repositoryRoutes = registrations.filter(
    route => route.path && route.path.startsWith('/api/repo/:owner/:repo')
  );
  assert(repositoryRoutes.length >= 100, 'repository inventory unexpectedly lost route families');
  for (const route of repositoryRoutes) {
    const key = `${route.method} ${route.path}`;
    assert.strictEqual(
      route.args[1],
      'providerSessionAccess',
      `${key} must attach only the local provider session before alpha authorization`
    );
    assert.strictEqual(
      route.args[2],
      'alphaRepositoryAccess',
      `${key} must enforce the invitation repository boundary before live provider credentials`
    );
    const authIndex = route.args.indexOf('auth');
    assert(authIndex > 2, `${key} must resolve live provider credentials only after alpha authorization`);
    const capabilityIndexes = route.args
      .map((arg, index) => arg.startsWith('capabilityAccess(') ? index : -1)
      .filter(index => index >= 0);
    for (const capabilityIndex of capabilityIndexes) {
      assert(
        capabilityIndex > 2 && capabilityIndex < authIndex,
        `${key} must run capability access after alpha authorization and before live provider credentials`
      );
    }
    for (const guarded of ['governanceAccess', 'governanceMutationContext', 'mutationContext']) {
      const guardedIndex = route.args.findIndex(arg => arg.startsWith(`${guarded}(`));
      if (guardedIndex >= 0) {
        assert(
          guardedIndex > authIndex,
          `${key} must preserve ${guarded} after provider authentication`
        );
      }
    }
  }
  return { registrations, repositoryRoutes };
}

function assertMiddlewarePrefix(registration, expected, message) {
  assert(registration, message.replace(' must ', ' is missing and must '));
  assert.deepStrictEqual(registration.args.slice(1, expected.length + 1), expected, message);
}

function validateSemanticRepositorySurfaces(source) {
  const semanticRegistrations = expressRegistrations(source);
  const findRoute = (method, routePath) => semanticRegistrations.find(
    entry => entry.method === method && entry.path === routePath
  );
  const surfaces = [
    ['GET', '/api/repos', [
      'providerSessionAccess',
      'alphaRepositoryListAccess',
      "capabilityAccess('repository.read')",
      'auth'
    ]],
    ['POST', '/api/repos', [
      'providerSessionAccess',
      "capabilityAccess('repository.create')",
      'auth'
    ]],
    ['GET', '/api/search', [
      'providerSessionAccess',
      "capabilityAccess('global-search')",
      'auth'
    ]],
    ['GET', '/api/notifications', [
      'providerSessionAccess',
      "capabilityAccess('notifications')",
      'auth'
    ]],
    ['POST', '/api/security/step-up', [
      'providerSessionAccess',
      'alphaStepUpRepositoryAccess',
      'auth'
    ]],
    ['POST', '/api/safety', [
      'providerSessionAccess',
      'alphaSafetyMutationAccess',
      'accountAuth'
    ]]
  ];
  for (const [method, routePath, expected] of surfaces) {
    assertMiddlewarePrefix(
      findRoute(method, routePath),
      expected,
      `${method} ${routePath} must enforce its semantic alpha/capability gates before credential or state access`
    );
  }
  const safetyRead = findRoute('GET', '/api/safety');
  assertMiddlewarePrefix(
    safetyRead,
    ['providerSessionAccess', 'accountAuth'],
    'GET /api/safety must use local provider authentication without live credentials'
  );
  assert(
    safetyRead.args.at(-1).includes('alphaSafetyView'),
    'GET /api/safety must filter protected repository metadata through the alpha scope view'
  );
  return semanticRegistrations;
}

const { registrations, repositoryRoutes } = validateAlphaRouteInventory(serverSource);
validateSemanticRepositorySurfaces(serverSource);
const route = (method, routePath) => registrations.find(
  entry => entry.method === method && entry.path === routePath
);

for (const [method, routePath] of [
  ['GET', '/api/alpha/status'],
  ['POST', '/api/alpha/redeem'],
  ['POST', '/api/alpha/end']
]) {
  assert(route(method, routePath), `missing ${method} ${routePath}`);
}

const alphaBoundary = registrations.find(
  entry => entry.method === 'USE'
    && entry.path === '/api'
    && entry.args[1] === 'alphaAccessBoundary'
);
assert(alphaBoundary, 'the global alpha boundary must be mounted for /api');
const workspaceRouter = registrations.find(entry => entry.method === 'USE'
  && entry.path === '/api/workspace' && /^createWorkspaceRouter\(/.test(entry.args[1]));
assert(workspaceRouter, 'workspace exceptions must be confined to the independently authenticated router');
assert(workspaceRouter.index < alphaBoundary.index);
const firstProtectedApi = registrations
  .filter(entry => entry.path && entry.path.startsWith('/api/'))
  .filter(entry => entry !== workspaceRouter)
  .filter(entry => !new Set([
    '/api/version',
    '/api/config',
    '/api/capabilities',
    '/api/alpha/status',
    '/api/alpha/redeem'
  ]).has(entry.path))
  .sort((left, right) => left.index - right.index)[0];
assert(
  alphaBoundary.index < firstProtectedApi.index,
  'the global alpha boundary must precede every protected legacy API route'
);

for (const [method, routePath, feature] of [
  ['POST', '/api/repos', 'repository.create'],
  ['DELETE', '/api/repo/:owner/:repo', 'repository.delete'],
  ['GET', '/api/search', 'global-search'],
  ['GET', '/api/notifications', 'notifications']
]) {
  const registration = route(method, routePath);
  assert(registration, `missing ${method} ${routePath}`);
  assert(
    registration.args.some(arg => arg.startsWith(`capabilityAccess('${feature}'`)),
    `${method} ${routePath} must fail through ${feature} before provider transport`
  );
}

const repositoryList = route('GET', '/api/repos');
assert(repositoryList, 'missing GET /api/repos');
assert.deepStrictEqual(
  repositoryList.args.slice(1, 5),
  ['providerSessionAccess', 'alphaRepositoryListAccess', "capabilityAccess('repository.read')", 'auth'],
  'repository listing must validate the full provider base URL before capability and credential resolution'
);

for (const provider of ['github', 'gitlab', 'gitea']) {
  const features = capabilityDocument.providers[provider]['hosted-alpha'];
  for (const feature of ['repository.create', 'repository.delete', 'global-search', 'notifications']) {
    assert.deepStrictEqual(
      features[feature].slice(0, 2),
      ['Unavailable', 'Unavailable'],
      `${provider} ${feature} must be explicitly unavailable without false provider parity`
    );
  }
}

assert.throws(
  () => validateAlphaRouteInventory(`${serverSource}
app.get('/api/repo/:owner/:repo/unreviewed-alpha-route', auth, capabilityAccess('repository.read'), (req, res) => res.json({}));
`),
  /unreviewed-alpha-route/,
  'a new repository route without the boundary must fail the exhaustive inventory'
);

assert.throws(
  () => validateSemanticRepositorySurfaces(serverSource.replace(
    "app.post('/api/security/step-up', providerSessionAccess, alphaStepUpRepositoryAccess, auth",
    "app.post('/api/security/step-up', providerSessionAccess, auth"
  )),
  /step-up/,
  'removing the body-carried repository boundary must fail the semantic inventory'
);

assert.throws(
  () => validateSemanticRepositorySurfaces(serverSource.replace(
    "app.post('/api/safety', providerSessionAccess, alphaSafetyMutationAccess, accountAuth",
    "app.post('/api/safety', providerSessionAccess, accountAuth"
  )),
  /safety/,
  'removing the aggregate safety mutation boundary must fail the semantic inventory'
);

console.log(`alpha access server contract tests passed (${repositoryRoutes.length} repository routes)`);
