const express = require('express');
const app = express();
const { exec } = require('child_process');
app.get('/ping', (req, res) => {
  exec(`ping -c 1 ${req.query.host}`, (error, out) => res.send(out)); // expect: SEC-011
});
