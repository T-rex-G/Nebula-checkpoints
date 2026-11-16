const express = require('express');
const app = express();
const { query } = require('./db');
app.get('/u', async (req, res) => { const id = parseInt(req.query.id, 10); res.json(await query('SELECT * FROM u WHERE id = ' + id)); });
