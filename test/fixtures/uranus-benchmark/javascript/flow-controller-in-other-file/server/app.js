const express = require('express');
const app = express();
const { show } = require('./controllers/users');
app.get('/u', show);
