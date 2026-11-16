const express = require('express');
const app = express();
const { build } = require('./sql');
app.get('/u', async (req, res) => { const q = build(req.query.name); res.json(await db.query(q)); }); // expect: SEC-001
