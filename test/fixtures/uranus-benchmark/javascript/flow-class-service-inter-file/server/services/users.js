const db = require('../db');
class UserService {
  find(name) { return db.query("SELECT * FROM u WHERE n = '" + name + "'"); } // expect: SEC-001
}
module.exports = UserService;
