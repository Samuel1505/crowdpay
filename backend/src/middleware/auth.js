const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    logger.warn('Invalid or expired token', { error: err.message });
    res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { requireAuth };
