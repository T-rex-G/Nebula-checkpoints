const db = require('../db');
exports.find = function (name) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); }; // expect: SEC-001
