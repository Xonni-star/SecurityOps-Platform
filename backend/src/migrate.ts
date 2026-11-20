import {pool} from './db/pool.js';
import {runMigrations} from './db/migration-runner.js';

try{
  const result=await runMigrations(pool);
  console.log(result.baselined?'Migration baseline recorded':`Applied ${result.applied.length} migration(s)`);
}finally{
  await pool.end();
}
