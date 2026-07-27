/** Migration CLI: `npm run migrate` / `npm run migrate:down`. */

import { migrateDown, migrateUp, openDatabase, defaultDatabasePath } from './index.ts';

const direction = process.argv[2] ?? 'up';
const path = process.env.DATABASE_PATH ?? defaultDatabasePath();
const db = openDatabase(path);

try {
  if (direction === 'up') {
    const ran = migrateUp(db);
    console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Already up to date.');
  } else if (direction === 'down') {
    const rolled = migrateDown(db);
    console.log(rolled ? `Rolled back: ${rolled}` : 'Nothing to roll back.');
  } else {
    console.error(`Unknown direction "${direction}". Use "up" or "down".`);
    process.exitCode = 1;
  }
} finally {
  db.close();
}
