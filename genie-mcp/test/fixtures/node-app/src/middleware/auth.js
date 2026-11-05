const { verifyToken } = require("../utils/token");

function requireAuth(req, _res, next) {
  verifyToken(req.headers.authorization);
  next();
}

module.exports = { requireAuth };
