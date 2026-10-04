const express = require('express');
const app = express();
const db = require('./db');
app.get('/users', async (req, res) => {
  const rows = await db.query("SELECT * FROM users WHERE name = '" + req.query.name + "'"); // expect: SEC-001 confirmed
  res.json(rows);
});
