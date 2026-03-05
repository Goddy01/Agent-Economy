#!/usr/bin/env node
/**
 * Post-install patch: rpc-websockets package.json is updated to export
 * ./dist/lib/client so @solana/web3.js can load it. Runs automatically
 * on npm install. Safe to skip if package not present.
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '../node_modules/rpc-websockets/package.json');
if (!fs.existsSync(pkgPath)) {
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (!pkg.exports || !pkg.exports.node) return;

const node = pkg.exports.node;
const browser = pkg.exports.browser || node;
// Subpath form: "." and "./dist/lib/client" both resolve to main entry
pkg.exports = {
  '.': { node, browser },
  './dist/lib/client': { node, browser },
};
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
