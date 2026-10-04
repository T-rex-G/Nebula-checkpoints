const express = require('express');
const app = express();
const { execFile } = require('child_process');
app.get('/ping', (req, res) => {
  execFile('ping', ['-c', '1', req.query.host], (error, out) => res.type('text').send(out));
});
