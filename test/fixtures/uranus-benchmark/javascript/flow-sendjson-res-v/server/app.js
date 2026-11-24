const express = require('express');
const app = express();
function reply(res, v) { res.json({ v }); }
app.get('/v', (req, res) => { reply(res, req.query.title); });
