const express = require('express');
const app = express();
const db = require('./db');
app.get('/users', async (req, res) => {
  const rows = await db.query('SELECT * FROM users WHERE name = $1', [req.query.name]);
  res.json(rows);
});
