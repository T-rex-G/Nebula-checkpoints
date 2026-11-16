const { exec } = require('child_process');
exports.convert = file => exec('convert ' + file + ' out.png'); // expect: SEC-011
