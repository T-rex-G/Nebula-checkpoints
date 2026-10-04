const express = require('express');
const app = express();
app.get('/continue', (req, res) => {
  res.redirect(req.query.next); // expect: SEC-020
});
