const express = require('express');
const app = express();
const fs = require('fs');
const path = require('path');
app.get('/files/:name', (req, res) => {
  fs.createReadStream(path.join(__dirname, 'uploads', req.params.name)).pipe(res); // expect: SEC-022
});
