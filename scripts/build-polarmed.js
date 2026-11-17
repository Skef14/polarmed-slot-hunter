const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const order = [
  'adapters/polarmed.js', 'adapters/polarmed-platform.js',
  'core/util.js', 'core/errors.js', 'core/filters.js', 'core/runner.js', 'core/index.js',
  'userscript/ui-state.js', 'userscript/ui-dom.js',
];
const header = fs.readFileSync(path.join(root, 'userscript/polarmed-header.js'), 'utf8').trim();
// Общие исходники интерфейса остаются одни. Меняется только маркировка
// отдельной сборки; ключи и канал не пересекаются с оригиналом ЕМИАС.
const parts = order.map((file) => {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  source = source.replaceAll('ЕМИАС', 'Polarmed').replaceAll('EmiasCore', 'PolarmedCore')
    .replaceAll('emiasSlotHunter', 'polarmedSlotHunter').replaceAll('emias-slot-hunter', 'polarmed-slot-hunter');
  return `/* ---- ${file} ---- */\n${source}`;
});
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').trim();
fs.writeFileSync(path.join(root, 'dist/polarmed-slot-hunter.user.js'),
  header + '\n\n/*\n' + license + '\n*/\n\n(function () {\n\'use strict\';\n' + parts.join('\n') + '\n})();\n');
console.log('Собран dist/polarmed-slot-hunter.user.js');
