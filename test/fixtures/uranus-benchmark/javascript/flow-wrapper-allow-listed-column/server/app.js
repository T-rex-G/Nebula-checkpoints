const express = require('express');
const app = express();
const { query } = require('./db');
const SORTS = ['name', 'age'];
app.get('/u', async (req, res) => { const s = SORTS.includes(req.query.sort) ? req.query.sort : 'name'; res.json(await query('SELECT * FROM u ORDER BY ' + s)); });
