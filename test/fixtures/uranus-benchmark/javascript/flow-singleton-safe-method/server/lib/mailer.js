const { execFile } = require('child_process');
class Mailer {
  send(to) { execFile('sendmail', [to]); }
}
module.exports = new Mailer();
