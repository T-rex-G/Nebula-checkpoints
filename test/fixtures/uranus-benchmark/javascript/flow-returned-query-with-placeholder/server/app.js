const express = require('express');
const app = express();
const { build } = require('./sql');
app.get('/u', async (req, res) => { const q = build(); res.json(await db.query(q, [req.query.name])); });
