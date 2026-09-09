#!/usr/bin/env node
import { main } from '../src/cli.js';

const controller = new AbortController();
const onInterrupt = () => controller.abort();
const wantsJson = process.argv.includes('--json');
process.once('SIGINT', onInterrupt);

main(process.argv.slice(2), { signal: controller.signal }).catch((error) => {
  if (error.name === 'AbortError') {
    if (wantsJson) console.error(JSON.stringify({ error: { code: 'ABORTED', message: 'Mission cancelled.' } }));
    else console.error('\n  Mission cancelled.\n');
    process.exitCode = 130;
    return;
  }
  if (wantsJson) console.error(JSON.stringify({ error: { code: 'MERGE_ROOM_ERROR', message: error.message } }));
  else if (process.env.MERGE_ROOM_DEBUG) console.error(error);
  else console.error(`\n  ${error.message}\n`);
  process.exitCode = 1;
}).finally(() => {
  process.removeListener('SIGINT', onInterrupt);
});
