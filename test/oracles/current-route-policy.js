'use strict';
/*
 * The route policy of whichever server this tree runs, read from its
 * composition root: server.js while the monolith existed, apps/api/src/main.ts
 * and the segments it calls since (route-policy.js).
 */
const { extractMonolithPolicy } = require('./route-policy');

function currentRoutePolicy(root) {
  return extractMonolithPolicy(root);
}

module.exports = { currentRoutePolicy };
