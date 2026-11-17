const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const header = fs.readFileSync(path.join(root, 'userscript/inspector-header.js'), 'utf8').trim();
const parts = ['adapters/polarmed.js', 'userscript/inspector.js']
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const output = path.join(root, 'dist/polarmed-site-inspector.user.js');
fs.writeFileSync(output, header + '\n\n(function () {\n' + parts.join('\n') + '\n})();\n');
console.log('Собран dist/polarmed-site-inspector.user.js');
