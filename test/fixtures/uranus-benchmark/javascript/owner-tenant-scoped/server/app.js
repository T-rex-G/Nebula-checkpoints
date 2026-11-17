const express = require('express');
const { requireAuth } = require('./auth');
const app = express();
app.use(express.json());
app.get('/projects/:id', requireAuth, async (req, res) => {
  const project = await knex('projects').where({ id: req.params.id, tenant_id: req.user.tenantId }).first();
  res.json(project);
});
