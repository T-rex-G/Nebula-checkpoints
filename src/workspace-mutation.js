'use strict';

const { createAuthorizationResolver, createUnavailableAuthorizationSnapshot } = require('./authorization-resolver');

function createWorkspaceMutationRunner({ gateway, request, descriptorFor }) {
  return async (req, action, operation) => {
    const input = { account: req.gh, owner: action === 'repository.create' ? req.gh.login : req.params.owner,
      repo: action === 'repository.create' ? req.body.name : req.params.repo,
      actorIdentityKey: req.workspaceExecution.identityKey };
    // Resolve afresh for this credential. Connections keep a stable resource key
    // across session/token rotation, which must not reuse an older token's grant.
    req.authorization = action === 'repository.create'
      ? createUnavailableAuthorizationSnapshot({ ...input, reasonCode: 'AUTHORIZATION_SCOPE_NOT_APPLICABLE' })
      : await createAuthorizationResolver({ request: ({ account, apiPath }) => request(account, apiPath) }).resolve(input);
    if (action === 'file.write' && (req.authorization.evidence.status !== 'resolved'
      || !req.authorization.repositoryAccess.complete || req.authorization.repositoryAccess.level < 30)) {
      throw Object.assign(new Error('This connection does not have verified repository write permission.'), {
        code: 'WORKSPACE_WRITE_PERMISSION_REQUIRED', status: 403, providerChanged: false
      });
    }
    return gateway.run({ ...descriptorFor(req, action), route: req.originalUrl.split('?')[0] }, operation);
  };
}

module.exports = { createWorkspaceMutationRunner };
