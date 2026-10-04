const express = require('express');
const db = require('./db');
const router = express.Router();

class Reports {
  remember(req) {
    this.region = req.query.region;
  }

  async list(req, res) {
    this.remember(req);
    res.json(await db.query("SELECT * FROM reports WHERE region = '" + this.region + "'")); // expect: SEC-001 to-confirm
  }
}

const reports = new Reports();
router.get('/reports', (req, res) => reports.list(req, res));
module.exports = router;
