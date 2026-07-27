/** Entry point for the availability propagation host. */

import { migrateUp, openDatabase } from '../db/index.ts';
import { createApp } from './app.ts';
import { loadTenantKeys } from './auth.ts';

const db = openDatabase();
migrateUp(db);

const tenantKeys = loadTenantKeys();
const port = Number(process.env.PORT ?? 4500);

createApp({ db, tenantKeys, defaultPropertyId: process.env.PROPERTY_ID }).listen(port, () => {
  console.log(`[server] availability propagation host on http://127.0.0.1:${port}`);
  if (tenantKeys.size === 0) {
    console.warn('[server] TENANT_API_KEYS is empty — no request can authenticate.');
  }
});
