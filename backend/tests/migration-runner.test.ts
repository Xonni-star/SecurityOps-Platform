import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMigrations,loadMigrationFiles} from '../src/db/migration-runner.js';

class FakeClient{
  readonly calls:string[]=[];
  records:Array<{version:number;migration_id:string;checksum:string;baseline:boolean}>=[];
  tenantsExists=false;
  async query<T=unknown>(text:string,values:unknown[]=[]):Promise<{rows:T[]}>{
    this.calls.push(text.trim());
    if(text.includes('SELECT version,migration_id')) return {rows:this.records as T[]};
    if(text.includes('information_schema.tables')&&values[1]==='tenants') return {rows:[{exists:this.tenantsExists}] as T[]};
    if(text.includes('information_schema.tables')||text.includes('information_schema.columns')) return {rows:[{exists:true}] as T[]};
    if(text.startsWith('INSERT INTO securityops_migrations')){
      this.records.push({version:Number(values[0]),migration_id:String(values[1]),checksum:String(values[2]),baseline:text.includes('true')});
    }
    return {rows:[] as T[]};
  }
  release():void{}
}

const makePool=(client:FakeClient)=>({connect:async()=>client});
const fixture=async(files:Record<string,string>)=>{
  const dir=await mkdtemp(join(tmpdir(),'securityops-migrations-'));
  await Promise.all(Object.entries(files).map(([name,sql])=>writeFile(join(dir,name),sql)));
  return dir;
};

afterEach(async()=>undefined);

test('orders migrations and rejects gaps',async()=>{
  const dir=await fixture({'001_first.sql':'select 1;','003_third.sql':'select 3;'});
  await expect(loadMigrationFiles(dir)).rejects.toThrow('Migration gap');
  await rm(dir,{recursive:true,force:true});
});

test('runs migrations transactionally with an advisory lock and is idempotent',async()=>{
  const dir=await fixture({'001_first.sql':'CREATE TABLE IF NOT EXISTS tenants (id integer);','002_second.sql':'INSERT INTO tenants(id) VALUES (1) ON CONFLICT DO NOTHING;'});
  const client=new FakeClient();
  const first=await runMigrations(makePool(client),dir);
  const second=await runMigrations(makePool(client),dir);
  expect(first.applied).toEqual(['001_first.sql','002_second.sql']);
  expect(second.applied).toEqual([]);
  expect(client.calls).toContain('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  expect(client.calls.filter(call=>call==='BEGIN')).toHaveLength(2);
  await rm(dir,{recursive:true,force:true});
});

test('accepts a data-only migration without schema requirements',async()=>{
  const dir=await fixture({'001_first.sql':'CREATE TABLE IF NOT EXISTS tenants (id integer);','002_seed.sql':'INSERT INTO tenants(id) VALUES (1) ON CONFLICT DO NOTHING;'});
  const client=new FakeClient();
  const result=await runMigrations(makePool(client),dir);
  expect(result.applied).toEqual(['001_first.sql','002_seed.sql']);
  expect(client.calls).toContain('INSERT INTO tenants(id) VALUES (1) ON CONFLICT DO NOTHING;');
  await rm(dir,{recursive:true,force:true});
});

test('rejects checksum drift before executing SQL',async()=>{
  const dir=await fixture({'001_first.sql':'select 1;'});
  const client=new FakeClient();
  await runMigrations(makePool(client),dir);
  await writeFile(join(dir,'001_first.sql'),'select changed;');
  await expect(runMigrations(makePool(client),dir)).rejects.toThrow('checksum drift');
  expect(client.calls.filter(call=>call==='select changed;')).toHaveLength(0);
  await rm(dir,{recursive:true,force:true});
});

test('rejects a recorded migration history gap',async()=>{
  const dir=await fixture({'001_first.sql':'select 1;','002_second.sql':'select 2;'});
  const client=new FakeClient();
  client.records=[{version:2,migration_id:'002_second.sql',checksum:'known',baseline:false}];
  await expect(runMigrations(makePool(client),dir)).rejects.toThrow('Migration history gap');
  await rm(dir,{recursive:true,force:true});
});

test('baselines an existing schema after validation',async()=>{
  const dir=await fixture({'001_first.sql':'CREATE TABLE IF NOT EXISTS tenants (id integer);'});
  const client=new FakeClient();
  client.tenantsExists=true;
  const result=await runMigrations(makePool(client),dir);
  expect(result).toEqual({applied:[],baselined:true});
  expect(client.records[0]?.baseline).toBe(true);
  await rm(dir,{recursive:true,force:true});
});

test('baselines a schema prefix that includes a data-only migration',async()=>{
  const dir=await fixture({
    '001_first.sql':'CREATE TABLE IF NOT EXISTS tenants (id integer);',
    '002_seed.sql':'INSERT INTO tenants(id) VALUES (1) ON CONFLICT DO NOTHING;',
    '003_second.sql':'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS name text;',
  });
  const client=new FakeClient();
  client.tenantsExists=true;
  const result=await runMigrations(makePool(client),dir);
  expect(result).toEqual({applied:[],baselined:true});
  expect(client.records).toHaveLength(3);
  await rm(dir,{recursive:true,force:true});
});
