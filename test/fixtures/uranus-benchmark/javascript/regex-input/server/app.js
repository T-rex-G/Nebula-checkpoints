const express = require('express');
const app = express();
const names = ['ada', 'grace', 'linus'];
app.get('/search', (req, res) => {
  const pattern = new RegExp(req.query.q); // expect: SEC-026
  res.json(names.filter(name => pattern.test(name)));
});
