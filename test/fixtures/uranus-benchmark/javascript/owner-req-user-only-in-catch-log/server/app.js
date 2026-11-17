const express = require('express');
const jwt = require('jsonwebtoken');
const app = express();
const requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
app.get('/files/:fileId', requireAuth, async (req, res) => { // expect: ACC-002 to-confirm
  try {
    const file = await File.findById(req.params.fileId);
    res.download(file.path);
  } catch (err) {
    logger.error({ userId: req.user.id, err });
    res.status(500).end();
  }
});
