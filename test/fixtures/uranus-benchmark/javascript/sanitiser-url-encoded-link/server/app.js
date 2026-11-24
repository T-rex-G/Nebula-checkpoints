const express = require('express');
const app = express();
app.get('/share', (req, res) => {
  const name = encodeURIComponent(req.query.name);
  res.send('<a href="/profile?name=' + name + '">profile</a>');
});
