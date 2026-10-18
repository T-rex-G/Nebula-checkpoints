'use strict';
/*
 * The route policy of whichever server this tree runs. While the monolith
 * exists it is read from server.js; the decomposed server publishes its route
 * table instead, in the same canonical form.
 */
const fs = require('fs');
const path = require('path');
const { extractMonolithPolicy } = require('./route-policy');

function currentRoutePolicy(root) {
  if (fs.existsSync(path.join(root, 'server.js'))) return extractMonolithPolicy(root);
  const { describeRoutePolicy } = require(path.join(root, 'apps', 'api', 'src', 'http', 'route-policy.ts'));
  return describeRoutePolicy();
}

module.exports = { currentRoutePolicy };
