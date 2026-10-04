const express = require('express');
const app = express();
app.get('/preview', async (req, res) => {
  const page = await fetch(req.query.url); // expect: SEC-021
  res.type('text').send(await page.text());
});
