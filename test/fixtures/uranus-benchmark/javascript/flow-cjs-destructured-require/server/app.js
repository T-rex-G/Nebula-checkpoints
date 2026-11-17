const express = require('express');
const app = express();
const { find } = require('./services/users');
app.get('/u', async (req, res) => { res.json(await find(req.query.name)); });
