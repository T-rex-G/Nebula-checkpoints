const express = require('express');
const app = express();
const { exec } = require('child_process');
function sanitizeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '');
}
app.get('/list', (req, res) => {
  const name = sanitizeName(req.query.name);
  exec('ls reports/' + name, (error, out) => res.send(out)); // known-fp: SEC-011 to-confirm
});
