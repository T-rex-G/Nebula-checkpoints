const express = require('express');
const app = express();
app.get('/u', (req, res) => { count().then(n => db.query('SELECT * FROM u LIMIT ' + n)).then(r => res.json(r)); }); // known-fp: SEC-001 to-confirm
async function count() { return 5; }
