const express = require('express');
const app = express();
app.get('/weather', async (req, res) => {
  const reply = await fetch(`https://api.weather.example.com/v1/cities/${encodeURIComponent(req.query.city)}`);
  res.json(await reply.json());
});
