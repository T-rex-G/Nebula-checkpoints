const express = require('express');
const app = express();
app.get('/continue', (req, res) => {
  res.redirect(`/dashboard?tab=${encodeURIComponent(req.query.tab)}`);
});
