const express = require('express');
const app = express();
const escapeHtml = require('escape-html');
app.get('/hello', (req, res) => {
  res.send(`<h1>Hello ${escapeHtml(req.query.name)}</h1>`);
});
