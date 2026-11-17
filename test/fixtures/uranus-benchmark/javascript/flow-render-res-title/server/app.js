const express = require('express');
const app = express();
function render(res, title) { res.send('<h1>' + title + '</h1>'); } // expect: SEC-033
app.get('/v', (req, res) => { render(res, req.query.title); });
