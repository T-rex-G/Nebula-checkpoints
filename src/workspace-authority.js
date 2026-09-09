'use strict';

const { digest, workspaceError } = require('./workspace-identity');
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Input is exclusively the context resolved from a live PostgreSQL session.
// This namespace never adopts legacy account hashes or tester-owned records.
function workspaceExecutionAuthority(context) {
  if (context?.role !== 'owner' || !UUID_RX.test(context.principalId || '') || !UUID_RX.test(context.workspaceId || '')) {
    throw workspaceError('WORKSPACE_SESSION_REQUIRED', 401);
  }
  if (!context.connection || !UUID_RX.test(context.connection.id || '')) throw workspaceError('WORKSPACE_CONNECTION_REQUIRED', 409);
  const { principalId, workspaceId, connection } = context;
  return Object.freeze({ kind: 'workspace', principalId, workspaceId, connectionId: connection.id,
    identityKey: digest(JSON.stringify(['nv-workspace-execution/v1', principalId, workspaceId, connection.id])) });
}

function assertWorkspaceExecutionPin(authority, headers) {
  if (headers['x-nv-workspace'] !== authority.workspaceId || headers['x-nv-connection'] !== authority.connectionId) {
    throw workspaceError('WORKSPACE_EXECUTION_CHANGED', 409);
  }
}

module.exports = { workspaceExecutionAuthority, assertWorkspaceExecutionPin };
