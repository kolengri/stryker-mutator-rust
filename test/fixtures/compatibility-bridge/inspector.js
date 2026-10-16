import { appendFileSync } from 'node:fs';
import { Session } from 'node:inspector';

const session = new Session();
session.connect();
session.on('Debugger.scriptParsed', ({ params }) => {
  if (params.url) appendFileSync(process.env.BRIDGE_TEST_MODULE_TRACE, `${params.url}\n`);
});
await new Promise((resolve, reject) => session.post('Debugger.enable', (error) => error ? reject(error) : resolve()));
