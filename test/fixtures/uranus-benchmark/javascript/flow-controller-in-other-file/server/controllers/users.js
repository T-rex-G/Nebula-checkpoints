const db = require('../db');
exports.show = async (req, res) => { res.json(await db.query("SELECT * FROM u WHERE n = '" + req.query.name + "'")); }; // expect: SEC-001
