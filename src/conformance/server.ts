/** Entry point for the channel conformance server. */

import { createConformanceServer } from './app.ts';

const port = Number(process.env.CONFORMANCE_PORT ?? 4599);
createConformanceServer().listen(port, () => {
  console.log(`[conformance] channel contracts on http://127.0.0.1:${port}`);
});
