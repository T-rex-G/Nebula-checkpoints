const express = require('express');
const app = express();
app.get('/u', (req, res) => {
  lookup(req.query.name).then(null, reason => res.send('<p>Failed: ' + reason.code + '</p>'));
});
async function lookup(name) { return name.trim(); }
