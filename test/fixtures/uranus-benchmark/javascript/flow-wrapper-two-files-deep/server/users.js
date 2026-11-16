const { query } = require('./db');
exports.byName = name => query("SELECT * FROM u WHERE n = '" + name + "'"); // expect: SEC-001
