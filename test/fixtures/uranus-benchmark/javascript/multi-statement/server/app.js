const express = require('express');
const db = require('./db');
const app = express();
app.get('/report', async (req, res) => {
  let where = 'WHERE 1 = 1';
  if (req.query.region) where += " AND region = '" + req.query.region + "'";
  const statement = 'SELECT region, sum(total) FROM sales ' + where;
  res.json(await db.query(statement)); // expect: SEC-001
});
