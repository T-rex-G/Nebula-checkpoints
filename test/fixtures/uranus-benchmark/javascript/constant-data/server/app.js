const express = require('express');
const app = express();
const { exec } = require('child_process');
const fs = require('fs');
const db = require('./db');
const REPORT = '/var/reports/daily.csv';
app.get('/report', async (req, res) => {
  exec('git rev-parse HEAD', (error, sha) => res.set('x-revision', sha.trim()));
  const rows = await db.query("SELECT count(*) FROM orders WHERE status = 'paid'");
  res.type('text/csv').send(fs.readFileSync(REPORT, 'utf8') + rows.length);
});
