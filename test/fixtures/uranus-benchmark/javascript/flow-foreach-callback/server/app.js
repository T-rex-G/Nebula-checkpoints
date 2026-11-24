const express = require('express');
const app = express();
const { exec } = require('child_process');
app.post('/u', (req, res) => { req.body.files.forEach(f => { exec('rm ' + f); }); res.end(); }); // expect: SEC-011, ACC-001 to-confirm
