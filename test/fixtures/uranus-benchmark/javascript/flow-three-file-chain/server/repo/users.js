const db = require('../db');
function byName(name) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); } // expect: SEC-001
module.exports = { byName };
