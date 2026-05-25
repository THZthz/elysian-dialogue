import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const TS_HEADER = `/**
 * Chorus — cinematic dialogue engine
 * Copyright (C) 2026 Amias
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

`;

const CSS_HEADER = `/*!
 * Chorus — cinematic dialogue engine
 * Copyright (C) 2026 Amias
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

`;

// Normalise by removing BOM and all whitespace
function normalise(str) {
  return str.replace(/^\uFEFF/, '').replace(/\s/g, '');
}

// True if the file's content starts with the given header (ignoring whitespace differences)
function hasHeader(content, header) {
  const normalisedHeader = normalise(header);
  // Read enough characters to cover the header even if there is leading whitespace
  const sample = content.slice(0, normalisedHeader.length * 3);
  return normalise(sample).startsWith(normalisedHeader);
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const files = [...walk('src'), ...walk('tests')].filter(f => {
  const ext = extname(f);
  return ['.ts', '.tsx', '.css', '.d.ts'].includes(ext) || f.endsWith('.d.ts');
});

let updated = 0;
for (const file of files) {
  const content = readFileSync(file, 'utf-8');
  const header = file.endsWith('.css') ? CSS_HEADER : TS_HEADER;

  if (hasHeader(content, header)) {
    console.log(`SKIP (header present): ${file}`);
    continue;
  }

  writeFileSync(file, header + content, 'utf-8');
  console.log(`OK: ${file}`);
  updated++;
}

console.log(`\nUpdated ${updated} files.`);
