const express = require('express');
const app = express();
app.use(express.json());
app.get('/calc', (req, res) => {
  res.json({ value: eval(req.query.expression) }); // expect: SEC-010
});
