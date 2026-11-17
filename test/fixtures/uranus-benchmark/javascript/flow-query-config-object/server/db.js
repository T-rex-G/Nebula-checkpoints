const { Pool } = require('pg');
const pool = new Pool();
exports.run = config => pool.query(config);
