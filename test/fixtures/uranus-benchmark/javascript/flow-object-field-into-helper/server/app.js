const express = require('express');
const app = express();
function find(opts) { return db.query("SELECT * FROM u WHERE n = '" + opts.name + "'"); } // expect: SEC-001
app.get('/u', async (req, res) => { const opts = { name: req.query.name, limit: 5 }; res.json(await find(opts)); });
