import request from 'supertest';
import type {QueryResult} from 'pg';
import {beforeEach,describe,expect,it,jest} from '@jest/globals';

const queryMock=jest.fn();
jest.unstable_mockModule('../src/db/pool.js',()=>({
  query:queryMock,
  withTransaction:async(work:(client:unknown)=>Promise<unknown>)=>work({query:queryMock}),
  withLoginContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withSessionContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
  withTenantContext:async(_value:string,work:()=>Promise<unknown>)=>work(),
}));

const {app}=await import('../src/app.js');

const tenant='00000000-0000-4000-8000-00000000000a';
const otherTenant='00000000-0000-4000-8000-00000000000b';
const userId='00000000-0000-4000-8000-000000000001';
const employee='00000000-0000-4000-8000-000000000002';
const qualification='00000000-0000-4000-8000-000000000003';
const catalogId='00000000-0000-4000-8000-000000000004';
const documentId='00000000-0000-4000-8000-000000000005';
const site='00000000-0000-4000-8000-0000000000aa';
const otherSite='00000000-0000-4000-8000-0000000000bb';

const csrf={Cookie:['securityops_session=opaque','securityops_csrf=csrf-value'],'x-csrf-token':'csrf-value'};
const permissions=[
  'qualifications:read','qualifications:write','qualifications:catalog:write','qualifications:revoke',
  'qualifications:documents:read','qualifications:documents:download','qualifications:reminders:write',
  'qualifications:export','sites:read','employees:read','dms:read',
];
const baseUser={
  id:userId,tenantId:tenant,email:'admin@example.invalid',role:'admin',permissions,permission_grants:[],
  site_ids:[site],is_system_admin:false,session_id:'session-1',csrf_token:'csrf-value',
  expires_at:'2099-01-01',device_id:'device-1',
};
let activeUser:Record<string,unknown>=baseUser;

const result=(rows:unknown[],rowCount=rows.length)=>({rows,rowCount}) as unknown as QueryResult;

type Handler={match:(sql:string)=>boolean;rows:(sql:string,values:unknown[])=>unknown[]};
let handlers:Handler[]=[];

function on(match:string,rows:unknown[]|((sql:string,values:unknown[])=>unknown[])){
  handlers.push({match:sql=>sql.includes(match),rows:typeof rows==='function'?rows:()=>rows});
}
function calls(match:string){
  return queryMock.mock.calls.filter(([sql])=>String(sql).includes(match));
}
function lastCall(match:string){
  const found=calls(match);
  return found[found.length-1];
}
function auditEvents(){
  return calls('INSERT INTO audit_events').map(call=>(call[1] as unknown[])??[]);
}
function day(offset:number){
  const date=new Date();
  date.setUTCDate(date.getUTCDate()+offset);
  return date.toISOString().slice(0,10);
}
function addDays(date:string,offset:number){
  const value=new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate()+offset);
  return value.toISOString().slice(0,10);
}
function overviewRow(overrides:Record<string,unknown>={}){
  return {
    id:qualification,employee_id:employee,employee_name:'Mia Guard',personnel_number:'P-100',code:'sachkunde_34a',
    qualification_name:'Sachkunde nach §34a',category:'Gesetzliche Qualifikationen',issued_on:day(-100),
    valid_from:day(-100),valid_until:day(30),status:'valid',revoked_at:null,document_id:null,notes:null,
    required:true,required_document_type:null,required_documents:[],default_validity_days:365,catalog_active:true,
    document_title:null,document_approval_status:null,document_valid_from:null,document_valid_until:null,
    document_lifecycle_state:null,site_name:'Objekt Nord',site_id:site,
    created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',...overrides,
  };
}
function catalogRow(overrides:Record<string,unknown>={}){
  return {
    id:catalogId,code:'erste_hilfe',name:'Erste Hilfe',description:null,category:'Erste Hilfe und medizinische Qualifikationen',
    default_validity_days:365,required:true,required_document_type:null,required_documents:[],active:true,
    created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',...overrides,
  };
}
function setupAssignment(existing:Record<string,unknown>[]=[]){
  on('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',[{id:employee}]);
  on('FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[{
    id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,required_document_type:null,
  }]);
  on('FROM employee_qualifications',
    (sql)=>existing.filter(row=>!sql.includes("status IN ('valid','expired')")||['valid','expired'].includes(String(row.status))));
  on('INSERT INTO employee_qualifications',[{
    id:qualification,tenant_id:tenant,employee_id:employee,catalog_id:catalogId,code:'sachkunde_34a',status:'valid',
  }]);
  on('UPDATE employee_qualifications',[{
    id:qualification,tenant_id:tenant,employee_id:employee,catalog_id:catalogId,code:'sachkunde_34a',status:'valid',
  }]);
  on('SELECT site_id FROM employee_object_assignments',[{site_id:site}]);
}

beforeEach(()=>{
  queryMock.mockReset();
  handlers=[];
  activeUser=baseUser;
  queryMock.mockImplementation(async(sql:string,values:unknown[]=[])=>{
    if(String(sql).includes('FROM sessions'))return result([activeUser]);
    const handler=handlers.find(candidate=>candidate.match(String(sql)));
    return result(handler?handler.rows(String(sql),values):[]);
  });
});

describe('qualification routes: Qualifikationskatalog',()=>{
  it('legt einen Katalogeintrag mit reason an und auditiert die Änderung',async()=>{
    on('INSERT INTO qualification_catalog',[catalogRow()]);
    const response=await request(app).post('/api/v1/qualifications/catalog').set(csrf).send({
      code:'erste_hilfe',name:'Erste Hilfe',category:'Erste Hilfe und medizinische Qualifikationen',
      default_validity_days:365,required:true,reason:'Jahresaudit 2026',
    });
    expect(response.status).toBe(201);
    expect(response.body.code).toBe('erste_hilfe');
    const insert=lastCall('INSERT INTO qualification_catalog')!;
    expect(insert[1][0]).toBe(tenant);
    expect(insert[1][1]).toBe('erste_hilfe');
    const audit=auditEvents().find(event=>event[2]==='qualification.catalog.created');
    expect(audit?.slice(0,4)).toEqual([tenant,userId,'qualification.catalog.created','qualification_catalog']);
    expect(audit?.[5]).toMatchObject({reason:'Jahresaudit 2026',code:'erste_hilfe'});
  });

  it('verhindert doppelte Katalogcodes mit 409',async()=>{
    on('INSERT INTO qualification_catalog',()=>{throw Object.assign(new Error('duplicate key'),{code:'23505'});});
    const response=await request(app).post('/api/v1/qualifications/catalog').set(csrf).send({
      code:'erste_hilfe',name:'Erste Hilfe',reason:'Jahresaudit 2026',
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('bereits');
  });

  it('bearbeitet und deaktiviert einen Katalogeintrag revisionsfähig',async()=>{
    on('SELECT * FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[catalogRow()]);
    on('UPDATE qualification_catalog',[catalogRow({name:'Erste Hilfe (neu)',active:false})]);
    const response=await request(app).patch(`/api/v1/qualifications/catalog/${catalogId}`).set(csrf).send({
      name:'Erste Hilfe (neu)',active:false,reason:'Katalog bereinigt',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({name:'Erste Hilfe (neu)',active:false});
    const update=lastCall('UPDATE qualification_catalog')!;
    expect(update[1].slice(0,2)).toEqual([tenant,catalogId]);
    const audit=auditEvents().find(event=>event[2]==='qualification.catalog.updated');
    expect(audit?.[5]).toMatchObject({reason:'Katalog bereinigt',code:'erste_hilfe'});
    expect(audit?.[5].changed_fields).toEqual(expect.arrayContaining(['name','active']));
  });
});

describe('qualification routes: Übersicht, Export und Analytics',()=>{
  it('liefert berechnete Statuswerte und Page-Header',async()=>{
    on('SELECT COUNT(*)::int count',[{count:3}]);
    on('SELECT q.id,q.employee_id',[overviewRow({valid_until:day(30)})]);
    const response=await request(app).get('/api/v1/qualifications/overview').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.headers['x-total-count']).toBe('3');
    expect(response.headers['x-page-count']).toBe('1');
    expect(response.body[0]).toMatchObject({
      computed_status:'expiring',status_label:'Läuft bald ab',issue_code:'expiring',
      employee_name:'Mia Guard',qualification_name:'Sachkunde nach §34a',
    });
    expect(response.body[0].days_until_expiry).toBeGreaterThan(0);
    expect(response.body[0].days_until_expiry).toBeLessThanOrEqual(90);
  });

  it('übersetzt Filter, Sortierung und Pagination in die erwarteten SQL-Parameter',async()=>{
    on('SELECT COUNT(*)::int count',[{count:25}]);
    on('SELECT q.id,q.employee_id',[overviewRow()]);
    const query=[
      'q=Erste','employee_id='+employee,'site_id='+site,'catalog_id='+catalogId,
      'code=sachkunde_34a','category=Brandschutz','status=expired',
      'expires_from=2026-01-01','expires_to=2026-12-31','days=30','missing_evidence=true',
      'sort=employee','dir=desc','page=2','pageSize=10',
    ].join('&');
    const response=await request(app).get(`/api/v1/qualifications/overview?${query}`).set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.headers['x-page-count']).toBe('3');
    const expectedFilterParams=[
      tenant,'%erste%',employee,site,catalogId,'sachkunde_34a','Brandschutz','expired',
      '2026-01-01','2026-12-31',30,
    ];
    expect(lastCall('SELECT COUNT(*)::int count')?.[1]).toEqual(expectedFilterParams);
    const data=lastCall('SELECT q.id,q.employee_id')!;
    expect(data[1]).toEqual([...expectedFilterParams,10,10]);
    expect(String(data[0])).toContain('ORDER BY e.name DESC,q.id ASC LIMIT $12 OFFSET $13');
    expect(String(data[0])).toContain('lower(e.name) LIKE $2');
    expect(String(data[0])).toContain('oa.site_id=$4');
    expect(String(data[0])).toContain("q.document_id IS NULL THEN 'missing_evidence'");
    expect(String(data[0])).toContain("Europe/Berlin");
  });

  it('verwendet bei der Freitextsuche ein wildcard-Muster für Teiltreffer',async()=>{
    on('SELECT COUNT(*)::int count',[{count:1}]);
    on('SELECT q.id,q.employee_id',[overviewRow()]);
    const response=await request(app).get('/api/v1/qualifications/overview?q=erste').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(lastCall('SELECT COUNT(*)::int count')?.[1][1]).toBe('%erste%');
  });

  it('weist ungültige Filterwerte mit 400 zurück statt einen DB-Fehler zu produzieren',async()=>{
    for(const query of ['employee_id=not-a-uuid','expires_from=31.12.2026','status=unknown','page=0','days=-1']){
      const response=await request(app).get(`/api/v1/qualifications/overview?${query}`).set('Cookie',csrf.Cookie);
      expect(response.status).toBe(400);
    }
    expect(calls('SELECT COUNT(*)::int count')).toHaveLength(0);
  });

  it('exportiert CSV mit BOM, deutschen Spalten und Audit-Eintrag',async()=>{
    on('SELECT q.id,q.employee_id',[overviewRow({
      employee_name:'Mia "M" Guard',site_name:'Nord;Süd',
      valid_from:new Date('2026-11-26T23:00:00.000Z'),valid_until:new Date('2027-11-26T23:00:00.000Z'),
      document_id:documentId,document_title:'Nachweis "34a"',document_approval_status:'approved',
      document_lifecycle_state:'available',required_document_type:'Nachweis',
    })]);
    const response=await request(app)
      .get('/api/v1/qualifications/export')
      .set('Cookie',csrf.Cookie)
      .buffer(true)
      .parse((res,callback)=>{
        const chunks:Buffer[]=[];
        res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
        res.on('end',()=>callback(null,Buffer.concat(chunks).toString('utf8')));
      });
    expect(response.status).toBe(200);
    const text=String(response.body);
    expect(text.charCodeAt(0)).toBe(0xFEFF);
    expect(text).toContain('Mitarbeiter;Personalnummer;Qualifikation;Kategorie');
    expect(text).toContain('"Mia ""M"" Guard"');
    expect(text).toContain('"Nord;Süd"');
    expect(text).toContain('"Nachweis ""34a"""');
    // UTC-Mitternacht in CET entspricht bereits dem nächsten Berliner Kalendertag.
    expect(text).toContain('2026-11-27');
    expect(text).toContain('2027-11-27');
    expect(text).toContain('\r\n');
    const audit=auditEvents().find(event=>event[2]==='qualifications.exported');
    expect(audit?.[0]).toBe(tenant);
    expect(audit?.[5]).toMatchObject({reason:'CSV-Export',count:1});
  });

  it('liefert die Analytics-Struktur mit berechneten Ablauf Listen',async()=>{
    on('SELECT COUNT(*)::int total',[{total:5,valid:2,expiring:1,expired:1,invalid_revoked:1,missing_evidence:1}]);
    on("FROM qualification_catalog WHERE tenant_id=$1 AND active=true GROUP BY 1",[{category:'Brandschutz',count:2}]);
    on("INTERVAL '30 days'",[overviewRow({valid_until:day(10)})]);
    on("INTERVAL '90 days'",[overviewRow({valid_until:day(60)})]);
    on('SELECT e.id employee_id,e.name employee,c.code',[{employee_id:employee,employee:'Mia Guard',code:'erste_hilfe'}]);
    on('FROM sites s',[{site_id:site,site:'Objekt Nord',qualified:3,requirement_count:1}]);
    const response=await request(app).get('/api/v1/qualifications/analytics').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.kpi).toMatchObject({total:5,expiring:1,missing_evidence:1});
    expect(response.body.categories).toEqual([{category:'Brandschutz',count:2}]);
    expect(response.body.expiring_30_days[0]).toMatchObject({computed_status:'expiring'});
    expect(response.body.expiring_90_days[0]).toMatchObject({computed_status:'expiring'});
    expect(response.body.missing_required).toHaveLength(1);
    expect(response.body.site_coverage).toHaveLength(1);
    const nonSession=queryMock.mock.calls.filter(([sql])=>!String(sql).includes('FROM sessions'));
    expect(nonSession.length).toBeGreaterThanOrEqual(6);
    for(const call of nonSession)expect((call[1] as unknown[])?.[0]).toBe(tenant);
  });
});

describe('qualification routes: Qualifikationszuordnungen',()=>{
  it('übernimmt die Standardgültigkeit aus dem Katalog',async()=>{
    setupAssignment();
    const validFrom=day(0);
    const response=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,valid_from:validFrom,reason:'Ersterfassung',
    });
    expect(response.status).toBe(201);
    const insert=lastCall('INSERT INTO employee_qualifications')!;
    expect(insert[1].slice(0,3)).toEqual([tenant,employee,catalogId]);
    expect(insert[1][4]).toBe(validFrom);
    expect(insert[1][6]).toBe(addDays(validFrom,30));
    const audit=auditEvents().find(event=>event[2]==='qualification.employee.created');
    expect(audit?.[5]).toMatchObject({reason:'Ersterfassung',valid_from:validFrom,valid_until:addDays(validFrom,30),site_id:site});
  });

  it('lehnt einen Code ab, der nicht zum gewählten Katalogeintrag passt',async()=>{
    setupAssignment();
    const response=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,code:'fremder_code',reason:'Code missverstanden',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Katalogeintrag');
    expect(calls('INSERT INTO employee_qualifications')).toHaveLength(0);
  });

  it('erstellt nach einem Widerruf eine neue Zertifizierung und behält die Historie',async()=>{
    setupAssignment([{id:qualification,status:'revoked',revoked_at:'2026-01-01T00:00:00Z',code:'sachkunde_34a'}]);
    const response=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,valid_from:day(0),reason:'Erneut zertifiziert',
    });
    expect(response.status).toBe(201);
    expect(calls('UPDATE employee_qualifications')).toHaveLength(0);
    expect(calls('INSERT INTO employee_qualifications')).toHaveLength(1);
    const audit=auditEvents().find(event=>event[2]==='qualification.employee.created');
    expect(audit?.[5]).toMatchObject({reason:'Erneut zertifiziert',previous:null});
  });

  it('aktualisiert eine bereits erfasste Qualifikation statt einen zweiten Datensatz anzulegen',async()=>{
    setupAssignment([{id:qualification,status:'valid',revoked_at:null,code:'sachkunde_34a',valid_from:null,valid_until:null}]);
    const response=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,valid_from:day(0),reason:'Verlängerung',
    });
    expect(response.status).toBe(201);
    expect(String(lastCall('FROM employee_qualifications')?.[0])).toContain("status IN ('valid','expired')");
    expect(calls('INSERT INTO employee_qualifications')).toHaveLength(0);
    expect(auditEvents().some(event=>event[2]==='qualification.employee.updated')).toBe(true);
  });

  it('weist eine leere Gültig-bis-Eingabe ab und markiert explizite Unbegrenztheit',async()=>{
    setupAssignment();
    const invalid=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,valid_from:day(0),valid_until:'',reason:'Leere Eingabe',
    });
    expect(invalid.status).toBe(400);
    const unlimited=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,valid_from:day(0),valid_until:null,reason:'Unbefristet',
    });
    expect(unlimited.status).toBe(201);
    const insert=lastCall('INSERT INTO employee_qualifications')!;
    expect(insert[1][6]).toBeNull();
    expect(insert[1][7]).toBe('unlimited');
  });

  it('berechnet die Standardgültigkeit mit Herkunft im Katalog',async()=>{
    setupAssignment();
    const validFrom=day(0);
    const response=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,valid_from:validFrom,reason:'Ersterfassung',
    });
    expect(response.status).toBe(201);
    expect(lastCall('INSERT INTO employee_qualifications')?.[1][7]).toBe('catalog_default');
  });

  it('erlaubt einen freigegebenen Nachweis und zeigt ihn in der Übersicht als gültig',async()=>{
    on('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',[{id:employee}]);
    on('FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[{
      id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,required_document_type:null,
    }]);
    on('FROM dms_documents d',[{id:documentId,document_type:null,employee_document_category:'qualification'}]);
    on('INSERT INTO employee_qualifications',[{id:qualification}]);
    on('SELECT site_id FROM employee_object_assignments',[{site_id:site}]);
    const assigned=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,document_id:documentId,reason:'Nachweis verknüpft',
    });
    expect(assigned.status).toBe(201);
    expect(lastCall('INSERT INTO employee_qualifications')?.[1][8]).toBe(documentId);
    on('SELECT COUNT(*)::int count',[{count:1}]);
    on('SELECT q.id,q.employee_id',[overviewRow({
      valid_until:day(200),document_id:documentId,document_approval_status:'approved',
      document_lifecycle_state:'available',required_document_type:'Nachweis',
    })]);
    const overview=await request(app).get('/api/v1/qualifications/overview').set('Cookie',csrf.Cookie);
    expect(overview.body[0]).toMatchObject({computed_status:'valid',document_status:'gueltig'});
  });

  it('akzeptiert einen Nachweis, der einem der geforderten Dokumenttypen entspricht',async()=>{
    on('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',[{id:employee}]);
    on('FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[{
      id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,
      required_document_type:'qualification',required_documents:['Qualifikationsnachweis'],
    }]);
    on('FROM dms_documents d',[{id:documentId,document_type:'Qualifikationsnachweis',employee_document_category:'qualification'}]);
    on('INSERT INTO employee_qualifications',[{id:qualification}]);
    on('SELECT site_id FROM employee_object_assignments',[{site_id:site}]);
    const assigned=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,document_id:documentId,reason:'Passender Dokumenttyp',
    });
    expect(assigned.status).toBe(201);
    const query=lastCall('FROM dms_documents d')!;
    expect(query[1][3]).toBe('qualification');
    expect(query[1][4]).toEqual(['Qualifikationsnachweis']);
    expect(String(query[0])).toContain('OR ($4::text IS NOT NULL AND d.document_type=$4)');
  });

  it('liefert für den Nachweis eine Download-URL mit konkreter freigegebener Version',async()=>{
    const versionId='00000000-0000-4000-8000-000000000006';
    on('SELECT q.document_id,q.employee_id,d.site_id',[{
      document_id:documentId,employee_id:employee,site_id:site,title:'Nachweis',approval_status:'approved',
      document_status:'active',version_id:versionId,
    }]);
    const response=await request(app).get(`/api/v1/qualifications/assignments/${qualification}/document`).set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body.download_url).toBe(`/api/v1/dms/documents/${documentId}/versions/${versionId}/download`);
    expect(response.body.preview_url).toBe(`/api/v1/dms/documents/${documentId}/versions/${versionId}/preview`);
    expect(response.body.download_url).not.toContain('latest');
  });

  it('verweigert den Nachweis-Download ohne dms:read',async()=>{
    activeUser={...baseUser,permissions:permissions.filter(permission=>permission!=='dms:read')};
    const response=await request(app).get(`/api/v1/qualifications/assignments/${qualification}/document`).set('Cookie',csrf.Cookie);
    expect(response.status).toBe(403);
  });

  it('zeigt einen nicht freigegebenen Nachweis als awaiting_review',async()=>{
    on('SELECT COUNT(*)::int count',[{count:1}]);
    on('SELECT q.id,q.employee_id',[overviewRow({
      valid_until:day(200),document_id:documentId,document_approval_status:'pending_approval',
      document_lifecycle_state:'available',required_document_type:'Nachweis',
    })]);
    const response=await request(app).get('/api/v1/qualifications/overview').set('Cookie',csrf.Cookie);
    expect(response.body[0]).toMatchObject({computed_status:'awaiting_review',document_status:'pruefung_ausstehend'});
  });

  it('lehnt Dokumente ab, die einem anderen Mitarbeiter gehören oder nicht freigegeben sind',async()=>{
    on('SELECT id FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',[{id:employee}]);
    on('FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[{
      id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,required_document_type:null,
    }]);
    on('FROM dms_documents d',[]);
    const response=await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({
      catalog_id:catalogId,document_id:documentId,reason:'Fremden Nachweis verknüpfen',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('anderen Mitarbeiter');
    const documentQuery=lastCall('FROM dms_documents d')!;
    expect(documentQuery[1]).toEqual([tenant,documentId,employee,null,[]]);
    expect(calls('INSERT INTO employee_qualifications')).toHaveLength(0);
  });

  it('behält valid_until bei einer Teilaktualisierung bei und erzeugt gültiges UPDATE-SQL',async()=>{
    const current={
      id:qualification,status:'valid',revoked_at:null,code:'sachkunde_34a',catalog_id:catalogId,
      issued_on:day(-100),valid_from:day(-100),valid_until:day(100),document_id:null,
      issuing_authority:null,notes:'alt',
    };
    on('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[current]);
    on('FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[{
      id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,required_document_type:null,
    }]);
    on('FROM qualification_catalog WHERE tenant_id=$1 AND code=$2 AND active=true',[{
      id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,required_document_type:null,
    }]);
    on('UPDATE employee_qualifications',[{...current,notes:'neu'}]);
    const response=await request(app).patch(`/api/v1/employees/${employee}/qualifications/${qualification}`).set(csrf).send({
      notes:'neu',reason:'Notiz korrigiert',
    });
    expect(response.status).toBe(200);
    const update=lastCall('UPDATE employee_qualifications')!;
    expect(update[1][7]).toBe(current.valid_until);
    // `catalog` ist keine Tabelle des UPDATE - der Katalogwert muss als Parameter gesetzt werden.
    expect(String(update[0])).not.toContain('code=catalog.code');
  });

  it('überschreibt valid_until bei expliziter Vorgabe',async()=>{
    const current={
      id:qualification,status:'valid',revoked_at:null,code:'sachkunde_34a',catalog_id:catalogId,
      issued_on:day(-100),valid_from:day(-100),valid_until:day(100),document_id:null,
      issuing_authority:null,notes:'alt',
    };
    on('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[current]);
    on('FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[{
      id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,required_document_type:null,
    }]);
    on('FROM qualification_catalog WHERE tenant_id=$1 AND code=$2 AND active=true',[{
      id:catalogId,code:'sachkunde_34a',default_validity_days:30,required:true,required_document_type:null,
    }]);
    on('UPDATE employee_qualifications',[{...current}]);
    const validUntil=day(300);
    const response=await request(app).patch(`/api/v1/employees/${employee}/qualifications/${qualification}`).set(csrf).send({
      valid_until:validUntil,reason:'Verlängert',
    });
    expect(response.status).toBe(200);
    expect(lastCall('UPDATE employee_qualifications')?.[1][7]).toBe(validUntil);
  });

  it('widerruft eine Qualifikation mit reason und Audit',async()=>{
    on('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[{
      id:qualification,status:'valid',revoked_at:null,code:'sachkunde_34a',
    }]);
    on("UPDATE employee_qualifications SET status='revoked'",[{id:qualification,status:'revoked',revoked_at:'2026-03-01T00:00:00Z'}]);
    const response=await request(app).post(`/api/v1/employees/${employee}/qualifications/${qualification}/revoke`).set(csrf).send({
      reason:'Nachweis zurückgezogen',
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('revoked');
    expect(lastCall("UPDATE employee_qualifications SET status='revoked'")?.[1]).toEqual([tenant,employee,qualification,'Nachweis zurückgezogen']);
    const audit=auditEvents().find(event=>event[2]==='qualification.employee.revoked');
    expect(audit?.[5]).toMatchObject({reason:'Nachweis zurückgezogen',employee_id:employee,current:{status:'revoked'}});
  });

  it(' entfernt eine Qualifikation revisionsfähig mit reason und Audit',async()=>{
    on('SELECT * FROM employee_qualifications WHERE tenant_id=$1 AND employee_id=$2 AND id=$3 FOR UPDATE',[{
      id:qualification,status:'valid',revoked_at:null,code:'sachkunde_34a',
    }]);
    on("UPDATE employee_qualifications SET status='invalid'",[]);
    const response=await request(app).delete(`/api/v1/employees/${employee}/qualifications/${qualification}`).set(csrf).send({
      reason:'Falsch erfasst',
    });
    expect(response.status).toBe(204);
    expect(lastCall("UPDATE employee_qualifications SET status='invalid'")?.[1]).toEqual([tenant,employee,qualification,'Falsch erfasst']);
    const audit=auditEvents().find(event=>event[2]==='qualification.employee.removed');
    expect(audit?.[5]).toMatchObject({reason:'Falsch erfasst',previous:{status:'valid'},current:{status:'invalid'}});
  });
});

describe('qualification routes: Berechtigungen und Mandantentrennung',()=>{
  it('verweigert Viewern alle schreibenden Qualifikationsendpunkte',async()=>{
    activeUser={...baseUser,role:'viewer',permissions:['qualifications:read'],site_ids:[]};
    on('SELECT COUNT(*)::int count',[{count:0}]);
    expect((await request(app).post('/api/v1/qualifications/catalog').set(csrf).send({code:'erste_hilfe',name:'Erste Hilfe',reason:'Test'})).status).toBe(403);
    expect((await request(app).post(`/api/v1/employees/${employee}/qualifications`).set(csrf).send({catalog_id:catalogId,reason:'Test'})).status).toBe(403);
    expect((await request(app).post(`/api/v1/employees/${employee}/qualifications/${qualification}/revoke`).set(csrf).send({reason:'Test'})).status).toBe(403);
    expect((await request(app).put('/api/v1/qualifications/reminders').set(csrf).send({reminder_days:[7],reason:'Test'})).status).toBe(403);
    expect((await request(app).get('/api/v1/qualifications/export').set('Cookie',csrf.Cookie)).status).toBe(403);
    expect((await request(app).get('/api/v1/qualifications/overview').set('Cookie',csrf.Cookie)).status).toBe(200);
    expect(calls('INSERT INTO audit_events')).toHaveLength(0);
  });

  it('zeigt einem anderen Mandanten keine Qualifikationsdaten',async()=>{
    activeUser={...baseUser,tenantId:otherTenant,permissions:['qualifications:read','qualifications:documents:read','sites:read']};
    on('SELECT COUNT(*)::int count',[{count:0}]);
    for(const path of ['/api/v1/qualifications/catalog','/api/v1/qualifications/overview','/api/v1/qualifications/reminders/history','/api/v1/qualifications/analytics']){
      const response=await request(app).get(path).set('Cookie',csrf.Cookie);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.anything());
    }
    const assignment=await request(app).get(`/api/v1/qualifications/assignments/${qualification}`).set('Cookie',csrf.Cookie);
    expect(assignment.status).toBe(404);
    const siteRequirements=await request(app).get(`/api/v1/sites/${site}/qualification-requirements`).set('Cookie',csrf.Cookie);
    expect(siteRequirements.status).toBe(200);
    const scoped=queryMock.mock.calls.filter(([sql])=>!String(sql).includes('FROM sessions'));
    expect(scoped.length).toBeGreaterThan(0);
    for(const call of scoped){
      expect((call[1] as unknown[])?.[0]).toBe(otherTenant);
      expect(call[1]).not.toContain(tenant);
    }
  });

  it('erlaubt Objektanforderungen nur mit Zugriff auf das Objekt',async()=>{
    activeUser={
      ...baseUser,permissions:[],permission_grants:[{code:'qualifications:read',scope:'site'}],site_ids:[site],
    };
    const allowed=await request(app).get(`/api/v1/sites/${site}/qualification-requirements`).set('Cookie',csrf.Cookie);
    expect(allowed.status).toBe(200);
    activeUser={...activeUser,site_ids:[otherSite]};
    const denied=await request(app).get(`/api/v1/sites/${site}/qualification-requirements`).set('Cookie',csrf.Cookie);
    expect(denied.status).toBe(403);
    expect(calls('FROM site_qualification_requirements r')).toHaveLength(1);
  });
});

describe('qualification routes: Erinnerungseinstellungen und Objektanforderungen',()=>{
  it('speichert sortierte, eindeutige Erinnerungstage mit reason',async()=>{
    on('INSERT INTO qualification_reminder_settings',[{reminder_days:[90,30,7],updated_at:'2026-03-01T00:00:00Z'}]);
    const response=await request(app).put('/api/v1/qualifications/reminders').set(csrf).send({
      reminder_days:[7,30,90,7],reason:'Neue Erinnerungslogik',
    });
    expect(response.status).toBe(200);
    expect(response.body.reminder_days).toEqual([90,30,7]);
    expect(lastCall('INSERT INTO qualification_reminder_settings')?.[1]).toEqual([tenant,[90,30,7],userId]);
    const audit=auditEvents().find(event=>event[2]==='qualification.reminders.updated');
    expect(audit?.[5]).toMatchObject({reason:'Neue Erinnerungslogik',reminder_days:[90,30,7]});
  });

  it('validiert Erinnerungstage und Pflicht-begründung',async()=>{
    for(const reminder_days of [[],[0],[3651],[1.5],Array.from({length:9},(_,index)=>index+1)]){
      const response=await request(app).put('/api/v1/qualifications/reminders').set(csrf).send({reminder_days,reason:'Test'});
      expect(response.status).toBe(400);
    }
    const missingReason=await request(app).put('/api/v1/qualifications/reminders').set(csrf).send({reminder_days:[7]});
    expect(missingReason.status).toBe(400);
    expect(calls('INSERT INTO qualification_reminder_settings')).toHaveLength(0);
  });

  it('liefert Standard-Erinnerungstage und konfigurierte Tage',async()=>{
    const fallback=await request(app).get('/api/v1/qualifications/reminders').set('Cookie',csrf.Cookie);
    expect(fallback.status).toBe(200);
    expect(fallback.body.reminder_days).toEqual([90,60,30,7]);
    on('SELECT reminder_days,updated_at FROM qualification_reminder_settings WHERE tenant_id=$1',[{reminder_days:[14,3],updated_at:'2026-03-01T00:00:00Z'}]);
    const configured=await request(app).get('/api/v1/qualifications/reminders').set('Cookie',csrf.Cookie);
    expect(configured.body.reminder_days).toEqual([14,3]);
  });

  it('liefert Erinnerungshistorie mit event_type, body und Zustellstatus',async()=>{
    on('FROM qualification_reminder_state s',[{
      qualification_id:qualification,days:7,due_date:day(7),event_key:`qualification.expiring:${tenant}:${qualification}:7:${day(0)}`,
      channel:'email',sent_at:'2026-03-01T00:00:00Z',event_type:'qualification.expiring',title:'Qualifikation läuft ab',
      body:'Sachkunde nach §34a läuft bald ab.',employee_id:employee,catalog_id:catalogId,code:'sachkunde_34a',
      qualification_name:'Sachkunde',employee_name:'Mia Guard',delivery_status:'sent',
      delivery_sent_at:'2026-03-01T00:05:00Z',last_error:null,
    }]);
    const response=await request(app).get('/api/v1/qualifications/reminders/history').set('Cookie',csrf.Cookie);
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      event_type:'qualification.expiring',body:'Sachkunde nach §34a läuft bald ab.',delivery_status:'sent',
    });
    expect(lastCall('FROM qualification_reminder_state s')?.[1]).toEqual([tenant]);
  });

  it('erstellt eine Objektanforderung nur mit Objektzugriff und auditiert sie',async()=>{
    on('SELECT id,code,name FROM qualification_catalog WHERE tenant_id=$1 AND id=$2 AND active=true',[catalogRow()]);
    on('INSERT INTO site_qualification_requirements',[{
      id:qualification,tenant_id:tenant,site_id:site,catalog_id:catalogId,required:true,active:true,
    }]);
    const response=await request(app).post(`/api/v1/sites/${site}/qualification-requirements`).set(csrf).send({
      catalog_id:catalogId,reason:'Pflichtqualifikation für Objekt',
    });
    expect(response.status).toBe(201);
    expect(lastCall('INSERT INTO site_qualification_requirements')?.[1].slice(0,3)).toEqual([tenant,site,catalogId]);
    expect(auditEvents().some(event=>event[2]==='site.qualification_requirement.created')).toBe(true);
  });
});
