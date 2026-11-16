const express = require('express');
const app = express();
const { query } = require('./db');
app.get('/u', async (req, res) => { res.json(await query(`SELECT * FROM u WHERE n = '${req.query.name}'`, [])); }); // expect: SEC-001
