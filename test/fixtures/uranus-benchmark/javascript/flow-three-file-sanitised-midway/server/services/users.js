const repo = require('../repo/users');
function find(id) { return repo.byId(parseInt(id, 10)); }
module.exports = { find };
