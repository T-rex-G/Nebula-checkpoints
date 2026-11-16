const express = require('express');
const app = express();
function find({ name }) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); } // expect: SEC-001
app.get('/u', async (req, res) => { res.json(await find({ name: req.query.name })); });
