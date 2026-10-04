const express = require('express');
const app = express();
app.set('view engine', 'ejs');
app.get('/hello', (req, res) => {
  res.render('hello', { name: req.query.name });
});
