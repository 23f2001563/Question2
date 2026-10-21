const crypto = require('crypto');

// Recursively sorts keys for exact digest matching
function sortKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted = {};
  Object.keys(obj).sort().forEach(key => {
    sorted[key] = sortKeys(obj[key]);
  });
  return sorted;
}

// Calculates lowercase hex SHA-256 over compact JSON
function calculateDigest(args) {
  const compactJson = JSON.stringify(sortKeys(args));
  return crypto.createHash('sha256').update(compactJson).digest('hex');
}

// Generates valid OTLP trace/span IDs
function generateHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { calculateDigest, generateHex };
