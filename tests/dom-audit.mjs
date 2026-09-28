import fs from 'node:fs';
import assert from 'node:assert/strict';

for (const name of ['index.html', 'operador.html', 'reportes.html']) {
  const html = fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicateIds, [], `${name}: IDs duplicados: ${duplicateIds.join(', ')}`);

  const references = [
    ...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g),
    ...html.matchAll(/querySelector\(['"]#([A-Za-z][\w-]*)/g),
  ].map(match => match[1]);
  const missing = [...new Set(references.filter(id => !ids.includes(id)))];
  assert.deepEqual(missing, [], `${name}: controles referidos pero inexistentes: ${missing.join(', ')}`);
}

console.log('OK: IDs únicos y controles enlazados en las tres pantallas.');
