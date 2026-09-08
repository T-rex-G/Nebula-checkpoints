'use strict';

const express = require('express');
const { workspaceError } = require('./workspace-identity');
const { workspaceExecutionAuthority, assertWorkspaceExecutionPin } = require('./workspace-authority');

const OWNER_FEATURES = new Set(['repository.read', 'repository.create', 'tree.read', 'file.read', 'file.write']);
const SHA_RX = /^[0-9a-f]{40}$/i;
const NAME_RX = /^[A-Za-z0-9_.-]{1,100}$/;
const OWNER_RX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function workspaceCapabilities(projection) {
  const features = Object.fromEntries(Object.entries(projection.features).map(([feature, value]) => [feature,
    OWNER_FEATURES.has(feature) ? { ...value } : { ...value, status: 'Unavailable', evidenceState: 'Unavailable',
      reason: 'This feature is not connected to the owner workbench yet.' }]));
  if (projection.provider === 'github') features['repository.create'] = {
    ...features['repository.create'], feature: 'repository.create', provider: 'github', authority: 'github.com',
    status: 'Experimental', evidenceState: 'Deterministic', deployment: projection.deployment,
    reason: 'Owner repository creation is available for validation. Cohort creation remains disabled.'
  };
  return { ...projection, features };
}

function fields(input, allowed, maxBytes = 8192) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.includes(key))
    || Buffer.byteLength(JSON.stringify(input), 'utf8') > maxBytes) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
}

function repoTarget(params) {
  if (!OWNER_RX.test(params.owner || '') || !NAME_RX.test(params.repo || '') || ['.', '..'].includes(params.repo)) {
    throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
  }
  return `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
}

function createWorkspaceWorkbenchRouter({ store, request, commitTree, fileEntryAtHead, assertCapability, projectCapabilities,
  loadSafety, updateSafety, guardSafety, runMutation, requireRepoPath, requireBranchName, normalizeBranches, failure }) {
  const router = express.Router();
  const wrap = (feature, handler) => async (req, res) => {
    try {
      if (!req.workspaceToken || !req.workspaceContext) throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.workspaceCsrfVerified !== true) throw workspaceError('CSRF_REQUIRED');
      const execution = await store.executionContext(req.workspaceToken);
      const authority = workspaceExecutionAuthority(execution.context);
      if (authority.principalId !== req.workspaceContext.principalId || authority.workspaceId !== req.workspaceContext.workspaceId) {
        throw workspaceError('WORKSPACE_EXECUTION_CHANGED', 409);
      }
      assertWorkspaceExecutionPin(authority, req.headers);
      if (execution.account.provider !== 'github') throw workspaceError('WORKSPACE_PROVIDER_UNSUPPORTED', 409);
      req.workspaceExecution = authority;
      req.gh = { ...execution.account, identityKey: authority.identityKey };
      const human = await request(req.gh, '/user');
      if (String(human.id) !== String(req.gh.providerAccountId) || human.type !== 'User' || !OWNER_RX.test(human.login || '')) {
        throw workspaceError('WORKSPACE_CONNECTION_REJECTED');
      }
      req.gh.login = human.login;
      if (feature && feature !== 'repository.create') assertCapability(req.gh, feature);
      if (req.params.owner || req.params.repo) req.workspaceRepoPath = repoTarget(req.params);
      await handler(req, res);
    } catch (error) {
      if (req.workspaceWriteDispatched) {
        error = Object.assign(new Error('The provider write could not be confirmed and may have completed.'), {
          code: 'WORKSPACE_WRITE_UNCERTAIN', status: 502, providerChanged: 'unknown',
          safeState: 'No automatic retry was requested.',
          nextAction: 'Refresh the repository on GitHub and inspect its latest commit before deliberately trying another write.'
        });
      }
      failure(res, error);
    }
  };
  const mutate = async (req, action, operation) => {
    req.effectiveSafety = await loadSafety(req.workspaceExecution.identityKey);
    const blocked = guardSafety(req);
    if (blocked) throw Object.assign(new Error(blocked), { code: 'WORKSPACE_SAFETY_BLOCKED', status: 423 });
    return runMutation(req, action, async () => {
      // Never replay after this boundary: even an interrupted response may have
      // changed provider state. The browser must reconcile explicitly.
      req.workspaceWriteDispatched = true;
      return operation();
    });
  };
  router.get('/me', wrap(null, async (req, res) => {
    const { principalId, workspaceId, connectionId } = req.workspaceExecution;
    res.json({ authorityKind: 'workspace', principalId, workspaceId, connectionId,
      provider: 'github', authority: 'github.com', login: req.gh.login, authMethod: 'token', avatar: '',
      caps: { prs: false, issues: false, releases: false, actions: false, lfs: false, tm: false, batch: false, search: false, notif: false, compare: false } });
  }));
  router.get('/capabilities', wrap(null, async (req, res) => {
    res.json(workspaceCapabilities(projectCapabilities(req.gh)));
  }));
  router.get('/safety', wrap(null, async (req, res) => res.json(await loadSafety(req.workspaceExecution.identityKey))));
  router.post('/safety', wrap(null, async (req, res) => {
    fields(req.body, ['readOnly', 'freezeSync', 'protect']);
    res.json(await updateSafety(req.workspaceExecution.identityKey, req.body));
  }));
  router.get('/repos', wrap('repository.read', async (req, res) => {
    fields(req.query, ['page', 'sort']);
    const page = Number(req.query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    const sort = req.query.sort || 'pushed';
    if (!['pushed', 'created', 'updated', 'full_name'].includes(sort)) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    const rows = await request(req.gh, `/user/repos?sort=${sort}&per_page=30&page=${page}&affiliation=owner,collaborator,organization_member`);
    res.json(rows.map(row => ({ full_name: row.full_name, name: row.name, owner: row.owner.login,
      private: !!row.private, description: row.description, default_branch: row.default_branch,
      language: row.language, stars: row.stargazers_count, forks: row.forks_count, pushed_at: row.pushed_at })));
  }));
  router.post('/repos', wrap('repository.create', async (req, res) => {
    fields(req.body, ['name', 'description', 'isPrivate']);
    if (!NAME_RX.test(req.body.name || '') || ['.', '..'].includes(req.body.name)
      || (req.body.description !== undefined && (typeof req.body.description !== 'string' || req.body.description.length > 350))
      || (req.body.isPrivate !== undefined && typeof req.body.isPrivate !== 'boolean')) throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    req.body.autoInit = true;
    const out = await mutate(req, 'repository.create', async () => {
      const created = await request(req.gh, '/user/repos', { method: 'POST', body: {
        name: req.body.name, description: req.body.description || '', private: req.body.isPrivate !== false, auto_init: true
      } });
      const expectedName = `${req.gh.login}/${req.body.name}`;
      if (String(created.full_name).toLowerCase() !== expectedName.toLowerCase()) throw new Error('Unexpected create result');
      const observed = await request(req.gh, `/repos/${encodeURIComponent(req.gh.login)}/${encodeURIComponent(req.body.name)}`);
      if (!created.id || observed.id !== created.id || !observed.default_branch) throw new Error('Repository creation could not be verified');
      return { full_name: observed.full_name, default_branch: observed.default_branch, verified: true };
    });
    res.status(201).json(out);
  }));
  router.get('/repo/:owner/:repo', wrap('repository.read', async (req, res) => {
    fields(req.query, []);
    const [info, branches] = await Promise.all([request(req.gh, req.workspaceRepoPath), request(req.gh, `${req.workspaceRepoPath}/branches?per_page=100`)]);
    res.json({ full_name: info.full_name, private: !!info.private, description: info.description,
      default_branch: info.default_branch, branches: normalizeBranches('github', branches) });
  }));
  router.get('/repo/:owner/:repo/tree', wrap('tree.read', async (req, res) => {
    fields(req.query, ['ref', 'path']);
    const branch = requireBranchName(req.query.ref);
    const path = req.query.path ? requireRepoPath(req.query.path) : '';
    const items = await request(req.gh, `${req.workspaceRepoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    const list = Array.isArray(items) ? items : [items];
    list.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    res.json(list.map(item => ({ name: item.name, path: item.path, type: item.type, sha: item.sha, size: item.size })));
  }));
  router.get('/repo/:owner/:repo/file', wrap('file.read', async (req, res) => {
    fields(req.query, ['ref', 'path']);
    const branch = requireBranchName(req.query.ref), path = requireRepoPath(req.query.path);
    const file = await request(req.gh, `${req.workspaceRepoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    const display = { name: file.name, path: file.path, sha: file.sha, size: file.size };
    if (file.type !== 'file' || file.size > 1024 * 1024) return res.json({ ...display, tooLarge: true });
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw workspaceError('WORKSPACE_FILE_UNAVAILABLE', 502);
    const bytes = Buffer.from(file.content, 'base64'), decoded = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(decoded, 'utf8').equals(bytes)) return res.json({ ...display, binary: true });
    const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\s*$/.exec(decoded);
    if (pointer) return res.json({ ...display, lfs: true, oid: pointer[1], size: Number(pointer[2]) });
    res.json({ ...display, content: file.content, encoding: file.encoding });
  }));
  router.put('/repo/:owner/:repo/file', wrap('file.write', async (req, res) => {
    fields(req.body, ['path', 'branch', 'content', 'message', 'sha', 'expectedHeadSha'], 2 * 1024 * 1024);
    req.body.path = requireRepoPath(req.body.path);
    req.body.branch = requireBranchName(req.body.branch);
    if (typeof req.body.content !== 'string' || Buffer.byteLength(req.body.content, 'utf8') > 1024 * 1024
      || req.body.content.includes('\0') || Buffer.from(req.body.content, 'utf8').toString('utf8') !== req.body.content
      || !SHA_RX.test(req.body.expectedHeadSha || '')
      || (req.body.message !== undefined && (typeof req.body.message !== 'string' || req.body.message.length > 1000))) {
      throw workspaceError('WORKSPACE_INPUT_INVALID', 400);
    }
    const refPath = `${req.workspaceRepoPath}/git/ref/heads/${encodeURIComponent(req.body.branch)}`;
    const before = await request(req.gh, refPath);
    if (before.object?.sha !== req.body.expectedHeadSha) throw Object.assign(new Error('Branch changed. Refresh before writing.'), { code: 'BRANCH_CHANGED', status: 409 });
    const prior = await fileEntryAtHead(req.gh, req.params.owner, req.params.repo, req.body.expectedHeadSha, req.body.path);
    if (prior && (prior.type !== 'blob' || !['100644', '100755'].includes(prior.mode))) {
      throw workspaceError('WORKSPACE_FILE_TYPE_UNSUPPORTED', 409);
    }
    const out = await mutate(req, 'file.write', async () => {
      const blob = await request(req.gh, `${req.workspaceRepoPath}/git/blobs`, { method: 'POST', body: {
        content: Buffer.from(req.body.content, 'utf8').toString('base64'), encoding: 'base64'
      } });
      const commit = await commitTree(req.gh, req.params.owner, req.params.repo, req.body.branch,
        req.body.message || `Update ${req.body.path} via Nebulaverse-X`, [{ path: req.body.path, sha: blob.sha,
          mode: prior?.mode || '100644', type: 'blob', forceMode: true }], req.body.expectedHeadSha);
      const observed = await request(req.gh, refPath);
      if (!SHA_RX.test(commit) || observed.object?.sha !== commit) throw new Error('Commit could not be verified');
      return { ok: true, sha: blob.sha, commit, verified: true };
    });
    res.json(out);
  }));
  router.use((req, res) => res.status(404).json({ code: 'WORKSPACE_ROUTE_NOT_FOUND', error: 'This action is not connected to the owner workbench yet.' }));
  return router;
}

module.exports = { createWorkspaceWorkbenchRouter, workspaceCapabilities };
