const express = require('express');
const app = express();
function run(sql) { return db.query(sql); } // expect: SEC-001
function find(name) { return run("SELECT * FROM u WHERE n = '" + name + "'"); }
app.get('/u', async (req, res) => { res.json(await find(req.query.name)); });
