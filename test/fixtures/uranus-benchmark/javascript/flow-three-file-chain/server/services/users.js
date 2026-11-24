const repo = require('../repo/users');
function find(name) { return repo.byName(name); }
module.exports = { find };
