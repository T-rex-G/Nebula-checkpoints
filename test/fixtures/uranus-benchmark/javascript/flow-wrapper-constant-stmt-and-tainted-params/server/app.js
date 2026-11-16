const express = require('express');
const app = express();
const { query } = require('./db');
app.get('/u', async (req, res) => { res.json(await query('SELECT * FROM u WHERE n = $1', [req.query.name])); });
