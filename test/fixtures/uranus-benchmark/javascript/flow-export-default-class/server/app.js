import express from 'express';
const app = express();
import Files from './files.js';
const files = new Files();
app.get('/f', (req, res) => { res.send(files.read(req.query.name)); });
