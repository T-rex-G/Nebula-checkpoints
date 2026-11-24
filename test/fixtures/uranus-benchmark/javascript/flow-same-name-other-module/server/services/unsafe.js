const db = require('../db');
function find(name) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); } // known-fp: SEC-001 to-confirm
module.exports = { find };
