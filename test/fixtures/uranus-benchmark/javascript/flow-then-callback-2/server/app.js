const express = require('express');
const app = express();
app.get('/u', (req, res) => { lookup(req.query.name).then(n => db.query("SELECT * FROM u WHERE n = '" + n + "'")).then(r => res.json(r)); }); // expect: SEC-001
async function lookup(v) { return v.trim(); }
