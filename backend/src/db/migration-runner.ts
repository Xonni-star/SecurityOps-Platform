import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Pool,PoolClient} from 'pg';

const MIGRATION_FILE_PATTERN=/^(?<version>\d+)_(?<name>[a-z0-9][a-z0-9_-]*)\.sql$/i;
const LOCK_KEY='securityops:migrations';
const METADATA_TABLE='securityops_migrations';

export type MigrationFile={version:number;id:string;name:string;path:string;sql:string;checksum:string};
export type MigrationResult={applied:string[];baselined:boolean};
type DbClient=Pick<Pool,'connect'>;
type Queryable=Pick<PoolClient,'query'>;

const schemaRequirements=(migrationFiles:MigrationFile[]):{table:string;column?:string}[]=>{
  const requirements=new Map<string,Set<string>>();
  for(const migration of migrationFiles){
    for(const match of migration.sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(/gi)){
      requirements.set(match[1],requirements.get(match[1])??new Set());
    }
    for(const match of migration.sql.matchAll(/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)){
      const columns=requirements.get(match[1])??new Set<string>();
      columns.add(match[2]);
      requirements.set(match[1],columns);
    }
  }
  const checks=Array.from(requirements.entries()).flatMap(([table,columns])=>[
    {table},
    ...Array.from(columns).map(column=>({table,column})),
  ]);
  if(checks.length===0) throw new Error('No schema requirements could be derived from migration files');
  return checks;
};

const requiredSchema=async(migrationsDir:string,migrationFiles?:MigrationFile[])=>schemaRequirements(migrationFiles??await loadMigrationFiles(migrationsDir));

export async function loadMigrationFiles(migrationsDir=resolve(process.cwd(),'migrations')):Promise<MigrationFile[]>{
  const names=(await readdir(migrationsDir)).filter(name=>name.endsWith('.sql'));
  const migrations:MigrationFile[]=[];
  for(const name of names){
    const match=MIGRATION_FILE_PATTERN.exec(name);
    if(!match) throw new Error(`Invalid migration filename "${name}"; expected NNN_name.sql`);
    const version=Number(match.groups?.version);
    const migrationName=match.groups?.name;
    if(!migrationName||!Number.isSafeInteger(version)||version<1) throw new Error(`Invalid migration version in "${name}"`);
    const sql=await readFile(resolve(migrationsDir,name),'utf8');
    migrations.push({
      version,
      id:name,
      name:migrationName,
      path:resolve(migrationsDir,name),
      sql,
      checksum:createHash('sha256').update(sql).digest('hex'),
    });
  }
  migrations.sort((a,b)=>a.version-b.version);
  for(let index=0;index<migrations.length;index++){
    const migration=migrations[index];
    if(index>0&&migration.version===migrations[index-1].version) throw new Error(`Duplicate migration version ${migration.version}`);
    const expected=index+1;
    if(migration.version!==expected) throw new Error(`Migration gap: expected version ${String(expected).padStart(3,'0')}, found ${migration.id}`);
  }
  return migrations;
}

async function validateBaseline(client:Queryable,migrationsDir:string,migrationFiles?:MigrationFile[]):Promise<void>{
  const checks=await requiredSchema(migrationsDir,migrationFiles);
  const missing:string[]=[];
  for(const check of checks){
    const result=check.column
      ? await client.query<{exists:boolean}>(
        'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3) AS exists',
        ['public',check.table,check.column],
      )
      : await client.query<{exists:boolean}>(
        'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS exists',
        ['public',check.table],
      );
    if(!result.rows[0]?.exists) missing.push(check.column?`${check.table}.${check.column}`:check.table);
  }

  if(missing.length>0) throw new Error(`Existing database is not the expected 9-migration baseline; missing ${missing.join(', ')}`);
}

async function isSchemaPresent(client:Queryable,migration:MigrationFile):Promise<boolean>{
  const checks=schemaRequirements([migration]);
  for(const check of checks){
    const result=check.column
      ? await client.query<{exists:boolean}>(
        'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3) AS exists',
        ['public',check.table,check.column],
      )
      : await client.query<{exists:boolean}>(
        'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS exists',
        ['public',check.table],
      );
    if(!result.rows[0]?.exists)return false;
  }
  return true;
}

async function ensureMetadataTable(client:Queryable):Promise<void>{
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
      version integer PRIMARY KEY,
      migration_id text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL,
      baseline boolean NOT NULL DEFAULT false
    )
  `);
}

export async function runMigrations(pool:DbClient,migrationsDir=resolve(process.cwd(),'migrations')):Promise<MigrationResult>{
  const migrations=await loadMigrationFiles(migrationsDir);
  const client=await pool.connect();
  const applied:string[]=[];
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[LOCK_KEY]);
    await ensureMetadataTable(client);
    const recorded=await client.query<{version:number;migration_id:string;checksum:string;baseline:boolean}>(
      `SELECT version,migration_id,checksum,baseline FROM ${METADATA_TABLE} ORDER BY version`,
    );
    const byVersion=new Map(recorded.rows.map(row=>[row.version,row]));
    for(let index=0;index<recorded.rows.length;index++){
      const expected=index+1;
      if(recorded.rows[index].version!==expected) throw new Error(`Migration history gap: expected version ${String(expected).padStart(3,'0')}`);
    }
    for(const row of recorded.rows){
      const migration=migrations.find(item=>item.version===row.version);
      if(!migration) throw new Error(`Recorded migration ${row.migration_id} is missing from the migration directory`);
      if(migration.id!==row.migration_id||migration.checksum!==row.checksum){
        throw new Error(`Migration checksum drift detected for ${row.migration_id}`);
      }
    }
    if(recorded.rows.length===0&&migrations.length>0){
      const anyBaselineObject=await client.query<{exists:boolean}>(
        'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2) AS exists',
        ['public','tenants'],
      );
      if(anyBaselineObject.rows[0]?.exists){
        let baselineCount=0;
        while(baselineCount<migrations.length&&await isSchemaPresent(client,migrations[baselineCount]))baselineCount++;
        if(baselineCount===0)throw new Error('Existing database is not the expected migration baseline; no complete migration prefix was found');
        await validateBaseline(client,migrationsDir,migrations.slice(0,baselineCount));
        for(const migration of migrations.slice(0,baselineCount)){
          await client.query(
            `INSERT INTO ${METADATA_TABLE} (version,migration_id,checksum,execution_ms,baseline) VALUES ($1,$2,$3,0,true)`,
            [migration.version,migration.id,migration.checksum],
          );
        }
        await client.query('COMMIT');
        return {applied:[],baselined:true};
      }
    }
    for(const migration of migrations){
      if(byVersion.has(migration.version)) continue;
      const started=Date.now();
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${METADATA_TABLE} (version,migration_id,checksum,execution_ms,baseline) VALUES ($1,$2,$3,$4,false)`,
        [migration.version,migration.id,migration.checksum,Date.now()-started],
      );
      applied.push(migration.id);
    }
    await client.query('COMMIT');
    return {applied,baselined:false};
  }catch(error){
    await client.query('ROLLBACK');
    throw error;
  }finally{
    client.release();
  }
}

export const migrationMetadataTable=METADATA_TABLE;
