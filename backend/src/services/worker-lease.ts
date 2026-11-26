import {randomUUID} from 'node:crypto';
import {query} from '../db/pool.js';

const holderId=randomUUID();

export async function tryAcquireWorkerLease(workerName:string,ttlMs:number):Promise<boolean>{
  if(!Number.isInteger(ttlMs)||ttlMs<1000)throw new Error('Worker-Lease-TTL muss mindestens eine Sekunde betragen');
  const result=await query(
    `INSERT INTO worker_leases(worker_name,holder_id,expires_at,updated_at)
     VALUES($1,$2,now()+($3::text || ' milliseconds')::interval,now())
     ON CONFLICT(worker_name) DO UPDATE
       SET holder_id=EXCLUDED.holder_id,expires_at=EXCLUDED.expires_at,updated_at=now()
       WHERE worker_leases.expires_at<=now() OR worker_leases.holder_id=$2
     RETURNING holder_id`,
    [workerName,holderId,ttlMs],
  );
  return result.rows.length===1;
}

export async function releaseWorkerLease(workerName:string):Promise<void>{
  await query('DELETE FROM worker_leases WHERE worker_name=$1 AND holder_id=$2',[workerName,holderId]);
}
