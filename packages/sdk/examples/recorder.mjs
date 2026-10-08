import { readFile } from 'node:fs/promises';
import { analyzeRecorderExport } from '@studio-loco/sdk';
if (!process.argv[2]) throw new Error('Usage: node recorder.mjs ./explicit-export.json');
console.log(analyzeRecorderExport(JSON.parse(await readFile(process.argv[2], 'utf8'))));
