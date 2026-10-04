const express = require('express');
const db = require('./db');
const app = express();
app.get('/orders/:id', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).end();
  res.json(await db.query(`SELECT * FROM orders WHERE id = ${id}`));
});
