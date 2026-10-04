const express = require('express');
const app = express();
const { findByEmail } = require('./users');
app.get('/lookup', async (req, res) => {
  res.json(await findByEmail(req.query.email));
});
