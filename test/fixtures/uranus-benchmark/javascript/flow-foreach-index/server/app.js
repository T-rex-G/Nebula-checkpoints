const express = require('express');
const { execFile } = require('child_process');
const app = express();
app.get('/u', requireAdmin, (req, res) => {
  req.query.names.split(',').forEach((name, index) => {
    execFile('touch', ['--', name]);
    res.write('<li>' + index + '</li>');
  });
  res.end();
});
