'use strict';
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
/* Every route with its guard chain, as the route policy reads them from the composition root and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
/*
 * That the Digital Twin answers its read model with the access its reader's
 * governance context allows, projected by the governance interface, is Kepler's
 * routes' (test/kepler-governance-routes.test.js); that the composed server
 * shows each person what GitHub's answer lets them do is
 * test/composition-governance.test.js's.
 */
const digitalTwin = locations(root).find(entry => entry.kind === 'route' && entry.method === 'GET' && entry.path === '/api/repo/:owner/:repo/governance/digital-twin');
assert(digitalTwin, 'Digital Twin route must remain repository scoped');
assert(digitalTwin.guards.includes("governanceAccess('reader')"), 'Digital Twin route must remain reader authorized');
console.log('governance interface server contract tests passed');
