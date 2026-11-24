const express = require('express');
const app = express();
function find(req) { return db.query("SELECT * FROM u WHERE n = '" + req.query.name + "'"); } // expect: SEC-001
app.get('/u', async (req, res) => { res.json(await find(req)); });
