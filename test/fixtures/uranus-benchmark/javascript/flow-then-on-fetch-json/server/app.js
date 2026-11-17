const express = require('express');
const app = express();
app.get('/u', (req, res) => { Promise.resolve(req.query.name).then(n => db.query("SELECT * FROM u WHERE n = '" + n + "'")); }); // expect: SEC-001
