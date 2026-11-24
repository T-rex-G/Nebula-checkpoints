const express = require('express');
const app = express();
const api = require('./api');
app.get('/p', async (req, res) => { res.json(await api.proxy(req.query.url)); });
