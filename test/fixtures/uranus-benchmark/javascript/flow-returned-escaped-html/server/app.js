const express = require('express');
const app = express();
const { card } = require('./views');
app.get('/c', (req, res) => { res.send(card(req.query.title)); });
