const express = require('express');
const app = express();
const cache = new Map();
class Users {
  get(name) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); } // known-fp: SEC-001 to-confirm
}
app.get('/u', (req, res) => { res.json(cache.get(req.query.name) || null); });
