const express = require('express');
const app = express();
const escapeHtml = require('escape-html');
app.get('/hello', (req, res) => {
  const name = escapeHtml(req.query.name);
  res.send('<h1>Hello ' + name + '</h1>');
});
