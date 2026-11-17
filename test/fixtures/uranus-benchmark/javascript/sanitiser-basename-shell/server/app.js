const express = require('express');
const app = express();
const { exec } = require('child_process');
const path = require('path');
app.get('/thumb', (req, res) => {
  const file = path.basename(req.query.file);
  exec('convert uploads/' + file + ' -resize 64x64 out.png', () => res.end()); // expect: SEC-011
});
