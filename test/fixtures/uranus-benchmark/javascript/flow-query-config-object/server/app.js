const express = require('express');
const app = express();
const { run } = require('./db');
app.get('/u', async (req, res) => { res.json(await run({ text: 'SELECT * FROM u WHERE n = $1', values: [req.query.name] })); });
