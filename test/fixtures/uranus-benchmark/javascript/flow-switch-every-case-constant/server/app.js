const express = require('express');
const app = express();
const db = require('./db');
app.get('/items', async (req, res) => {
  let order = req.query.order;
  switch (order) {
    case 'desc':
      order = 'DESC';
      break;
    default:
      order = 'ASC';
  }
  res.json(await db.query('SELECT * FROM items ORDER BY name ' + order)); // known-fp: SEC-001
});
