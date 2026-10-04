const express = require('express');
const app = express();
const db = require('./db');
app.get('/users', async (req, res) => {
  const name = req.query.name.replace("'", "");
  res.json(await db.query("SELECT * FROM users WHERE name = '" + name + "'")); // expect: SEC-001
});
