const express = require('express');
const app = express();
function exec3(sql) { return db.query(sql); } // expect: SEC-001
function run(sql) { return exec3(sql); }
function find(name) { return run("SELECT * FROM u WHERE n = '" + name + "'"); }
app.get('/u', async (req, res) => { res.json(await find(req.query.name)); });
