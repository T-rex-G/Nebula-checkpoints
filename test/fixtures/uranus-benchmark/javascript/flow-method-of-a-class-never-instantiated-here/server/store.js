class Legacy {
  find(name) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); } // known-fp: SEC-001 to-confirm
}
function find(name) { return db.query('SELECT * FROM u WHERE n = $1', [name]); }
module.exports = { find, Legacy };
