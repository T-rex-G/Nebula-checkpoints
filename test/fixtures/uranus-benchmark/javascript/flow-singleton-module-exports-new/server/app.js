const express = require('express');
const app = express();
const mailer = require('./lib/mailer');
app.post('/m', (req, res) => { mailer.send(req.body.to); res.end(); }); // expect: ACC-001 to-confirm
