const express = require('express');
const app = express();
const ALLOWED = new Set(['api.example.com', 'cdn.example.com']);
function validateUrl(url) {
  if (!ALLOWED.has(new URL(url).hostname)) throw new Error('host not allowed');
  return url;
}
app.get('/preview', async (req, res) => {
  const target = validateUrl(req.query.url);
  const reply = await fetch(target);
  res.send(await reply.text());
});
