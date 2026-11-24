const db = require('../db');
function find(name) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); } // expect: SEC-001
module.exports = { find };
