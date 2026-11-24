const express = require('express');
const app = express();
const { exec } = require('child_process');
const escapeHtml = require('escape-html');
app.get('/ping', (req, res) => {
  const host = escapeHtml(req.query.host);
  exec('ping -c 1 ' + host, (error, out) => res.send(out)); // expect: SEC-011
});
