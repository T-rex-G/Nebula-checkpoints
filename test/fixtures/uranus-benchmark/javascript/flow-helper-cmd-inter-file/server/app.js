const express = require('express');
const app = express();
const { convert } = require('./lib/img');
app.post('/c', (req, res) => { convert(req.body.file); res.end(); });
