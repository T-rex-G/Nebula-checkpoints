const express = require('express');
const app = express();
class Reports {
  run(sql) { return db.query(sql); } // expect: SEC-001
  byRegion(region) { return this.run("SELECT * FROM r WHERE region = '" + region + "'"); }
}
const reports = new Reports();
app.get('/r', async (req, res) => { res.json(await reports.byRegion(req.query.region)); });
