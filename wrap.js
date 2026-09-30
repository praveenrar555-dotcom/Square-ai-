// Express 4 async errors ko apne aap catch nahi karta, isliye yeh wrapper
module.exports = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
