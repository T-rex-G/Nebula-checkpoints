const express = require('express');
const app = express();
const ejs = require('ejs');
app.get('/card', (req, res) => {
  res.send(ejs.render(req.query.template, { user: 'guest' })); // expect: SEC-030
});
