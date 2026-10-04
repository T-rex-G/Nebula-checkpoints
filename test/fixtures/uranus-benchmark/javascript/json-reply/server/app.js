const express = require('express');
const app = express();
app.get('/echo', (req, res) => {
  res.json({ query: req.query, agent: req.get('user-agent') });
});
