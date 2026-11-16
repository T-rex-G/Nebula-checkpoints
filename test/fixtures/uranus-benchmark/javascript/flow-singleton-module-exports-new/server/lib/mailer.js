const { exec } = require('child_process');
class Mailer {
  send(to) { exec('sendmail ' + to); } // expect: SEC-011
}
module.exports = new Mailer();
