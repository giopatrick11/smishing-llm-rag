function createRateLimiter({ limit = 30, windowMs = 60000, now = Date.now } = {}) {
  const clients = new Map();
  return function rateLimit(req, res, next) {
    const time = now();
    const key = req.ip;
    const current = clients.get(key);
    const entry = !current || time >= current.resetAt
      ? { count: 0, resetAt: time + windowMs }
      : current;
    entry.count += 1;
    clients.set(key, entry);
    if (entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - time) / 1000)));
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    next();
  };
}

module.exports = { createRateLimiter };
