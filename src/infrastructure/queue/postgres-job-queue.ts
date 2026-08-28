import { Pool, type QueryResultRow } from 'pg';
import type { EnqueueJob, JobQueue } from '../../application/ports/job-queue';
import type { Job } from '../../domain/models';
import { stableId } from '../../lib/util';

export class PostgresJobQueue implements JobQueue {
  private readonly pool: Pool;
  constructor(connectionString: string, maxConnections = 5) {
    this.pool = new Pool({connectionString,max:maxConnections,statement_timeout:5_000,application_name:'recruiting-os-queue'});
  }
  async enqueue(input: EnqueueJob): Promise<Job> {
    const client=await this.pool.connect();const id=stableId('job',`${input.tenantId}:${input.type}:${input.idempotencyKey}`);
    try{await client.query('begin');await client.query(`select set_config('app.tenant_id',$1,true)`,[input.tenantId]);
      await client.query(`insert into jobs(id,tenant_id,type,idempotency_key,payload,status,priority,max_attempts,available_at)
        values($1,$2,$3,$4,$5,'queued',$6,$7,$8) on conflict(tenant_id,type,idempotency_key) do nothing`,
        [id,input.tenantId,input.type,input.idempotencyKey,JSON.stringify(input.payload),input.priority??100,input.maxAttempts??5,input.availableAt??new Date().toISOString()]);
      const row=(await client.query('select * from jobs where id=$1',[id])).rows[0];await client.query('commit');return this.map(row);
    }catch(error){await client.query('rollback');throw error;}finally{client.release();}
  }
  async leaseNext(workerId:string,leaseSeconds=60):Promise<Job|undefined>{
    const row=(await this.pool.query('select * from app.lease_job($1,$2)',[workerId,leaseSeconds])).rows[0];return row?this.map(row):undefined;
  }
  async complete(job:Job):Promise<void>{await this.pool.query('select app.finish_job($1,$2,null)',[job.id,job.leasedUntil]);}
  async fail(job:Job,error:unknown):Promise<void>{await this.pool.query('select app.finish_job($1,$2,$3)',[job.id,job.leasedUntil,(error instanceof Error?error.message:String(error)).slice(0,500)]);}
  async close():Promise<void>{await this.pool.end();}
  private map(row:QueryResultRow):Job{return{id:row.id,tenantId:row.tenant_id,type:row.type,
    idempotencyKey:row.idempotency_key,payload:row.payload,status:row.status,
    attemptCount:row.attempt_count,maxAttempts:row.max_attempts,availableAt:row.available_at.toISOString(),
    leasedUntil:row.leased_until?.toISOString()};}
}
