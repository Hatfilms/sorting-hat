const fs = require('fs');
const path = require('path');

const versionFilePath = path.join(__dirname, '..', 'version.json');

let current = { build: 0 };
if (fs.existsSync(versionFilePath)) {
  current = JSON.parse(fs.readFileSync(versionFilePath, 'utf8'));
}

current.build = (current.build || 0) + 1;

fs.writeFileSync(versionFilePath, JSON.stringify(current, null, 2) + '\n');

console.log(`[VERSION] Build number bumped to ${current.build}`);
