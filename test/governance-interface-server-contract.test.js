'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { serverSource } = require('./helpers/server-source');
const root = path.resolve(__dirname, '..');
const server = serverSource();
const governanceRoutes = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'kepler', 'http', 'governance-routes.ts'), 'utf8');
/* Every route with its guard chain, as the route policy reads them from the composition root and the modules' registrations. */
const { locations } = require('./oracles/route-policy');
assert(/import \{ projectGovernanceInterfaceAccess \} from '\.\.\/domain\/governance-interface\.ts'/.test(governanceRoutes), 'the governance routes must load the bounded governance interface access projection');
assert(governanceRoutes.includes('projectGovernanceInterfaceAccess(governance(req).authorization)'), 'Digital Twin route must derive access from the server authorization snapshot');
assert(server.includes('governance: governanceOf') && server.includes('export const governanceOf = (req: GuardedRequest): GovernanceRequest => req.governance!;'), 'the routes must read the governance context the server guard attached');
assert(governanceRoutes.includes('res.json({ digitalTwin, access })'), 'Digital Twin route must return the read model and bounded access envelope');
const digitalTwin = locations(root).find(entry => entry.kind === 'route' && entry.method === 'GET' && entry.path === '/api/repo/:owner/:repo/governance/digital-twin');
assert(digitalTwin, 'Digital Twin route must remain repository scoped');
assert(digitalTwin.guards.includes("governanceAccess('reader')"), 'Digital Twin route must remain reader authorized');
console.log('governance interface server contract tests passed');
