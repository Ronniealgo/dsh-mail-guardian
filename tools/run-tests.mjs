import fs from 'node:fs';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const suites=fs.readdirSync(path.join(root,'test')).filter(f=>f.endsWith('.test.mjs')).sort();
if(!suites.length)throw new Error('No test suites found');
for(const name of suites)await import(pathToFileURL(path.join(root,'test',name)).href);
