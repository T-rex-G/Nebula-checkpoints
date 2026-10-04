const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.get('/files', (req, res) => {
  const file = path.normalize(req.query.file);
  res.send(fs.readFileSync(path.join('/srv/files', file))); // expect: SEC-022
});
