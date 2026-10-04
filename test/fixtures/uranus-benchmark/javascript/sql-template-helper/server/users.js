const pool = require('./pool');
async function findByEmail(email) {
  return pool.query(`SELECT * FROM users WHERE email = '${email}'`); // expect: SEC-001
}
module.exports = { findByEmail };
