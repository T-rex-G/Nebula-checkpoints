const escapeHtml = require('escape-html');
exports.card = title => '<div class="card"><h2>' + escapeHtml(title) + '</h2></div>';
