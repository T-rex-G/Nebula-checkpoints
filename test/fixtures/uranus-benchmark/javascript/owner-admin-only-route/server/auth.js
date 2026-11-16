const jwt = require('jsonwebtoken');
exports.requireAuth = (req, res, next) => { try { req.user = jwt.verify(req.headers.authorization, process.env.SECRET); next(); } catch { res.status(401).end(); } };
exports.requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).end());
