const express = require('express');
const app = express();
function validateUrl(url) {
  if (!url.startsWith('https://')) throw new Error('https only');
  return url;
}
app.get('/preview', async (req, res) => {
  const target = validateUrl(req.query.url);
  const reply = await fetch(target); // expect: SEC-021 to-confirm
  res.send(await reply.text());
});
