const db = require('../db');
function find(name) { return db.query('SELECT * FROM u WHERE n = $1', [name]); }
module.exports = { find };
