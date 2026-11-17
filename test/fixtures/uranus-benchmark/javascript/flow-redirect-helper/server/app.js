const express = require('express');
const app = express();
function go(res, to) { res.redirect(to); } // expect: SEC-020
app.get('/v', (req, res) => { go(res, req.query.next); });
