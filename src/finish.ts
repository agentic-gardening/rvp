// node agent/dist/result.mjs <outDir>
import { finish } from './result';

const result = finish(process.argv[2], process.env);
console.log(`outcome: ${result.outcome} (${result.checks.length} checks)`);
