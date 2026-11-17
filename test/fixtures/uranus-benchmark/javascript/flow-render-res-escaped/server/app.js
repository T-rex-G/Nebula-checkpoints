const express = require('express');
const app = express();
const escapeHtml = require('escape-html');
function render(res, title) { res.send('<h1>' + escapeHtml(title) + '</h1>'); }
app.get('/v', (req, res) => { render(res, req.query.title); });
