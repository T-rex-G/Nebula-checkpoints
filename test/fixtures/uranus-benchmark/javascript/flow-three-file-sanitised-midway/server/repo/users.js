const db = require('../db');
function byId(id) { return db.query('SELECT * FROM u WHERE id = ' + id); } // known-fp: SEC-001 to-confirm
module.exports = { byId };
