import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import {
  adminEmail,adminPassword,berlinDate,email,errorJson,fixture,hasPath,loginApi,loginUi,
  openApiPaths,password,permissionList,readJson,type Row,type Session,
} from './helpers/operative-e2e';

/**
 * Kundenberichte: echte Fachdaten, gespeicherte Datenbasis, Vier-Augen-Freigabe
 * und ein schreibgeschütztes Kundenportal. Alle Schreibzugriffe laufen gegen den
 * isolierten Fixture-Tenant; es werden keine Produktionsdaten verwendet.
 */
test.skip(process.env.E2E_FIXTURE!=='isolated',
  'Nur gegen den isolierten Fixture-Tenant ausführen (E2E_FIXTURE=isolated).');
test.skip(!email||!password,'E2E_EMAIL und E2E_PASSWORD müssen gesetzt sein.');

const runId=`${Date.now().toString(36)}${randomUUID().slice(0,6)}`;
const confidentialNote=`VERTRAULICHE-E2E-NOTIZ-${runId}`;
const siteId=fixture.siteId;
const title=`Nachweisbericht ${runId}`;
const reportFilters=()=>({from:berlinDate(-30),to:berlinDate(0)});

async function logoutUi(page:Page):Promise<void>{
  await page.goto('/');
  await page.evaluate(async()=>{
    const csrf=decodeURIComponent(document.cookie.split('; ').find(v=>v.startsWith('securityops_csrf='))?.split('=').slice(1).join('=')??'');
    await fetch('/api/v1/auth/logout',{method:'POST',headers:{'x-csrf-token':csrf}});
  });
}

test('Kundenbericht: Datenbasis, Vier-Augen-Freigabe, Portal und Widerruf',async({request,playwright,page}:{
  request:Parameters<typeof openApiPaths>[0];playwright:any;page:Page;
})=>{
  test.setTimeout(180_000);

  let author:Session|undefined;
  let approver:Session|undefined;
  let viewer:Session|undefined;
  let customerId='';
  let releaseId='';
  let incidentId='';

  try{
    await test.step('Fixtures und OpenAPI prüfen',async()=>{
      const ready=await request.get(`${process.env.E2E_API_BASE_URL??'http://127.0.0.1:3000'}/ready`);
      expect(ready.ok(),`Backend nicht bereit: HTTP ${ready.status()}`).toBeTruthy();
      const paths=await openApiPaths(request);
      for(const path of ['/customer-reports/kinds','/customer-reports/releases','/customer-reports/preview/{kind}',
        '/customer-reports/releases/{id}/approve','/customer-reports/releases/{id}/export',
        '/customer-portal/releases','/customer-portal/releases/{id}']) {
        expect(hasPath(paths,path,'get')||hasPath(paths,path,'post'),`OpenAPI fehlt: ${path}`).toBeTruthy();
      }
      author=await loginApi(playwright,email,password,'playwright-customer-reports-author');
      approver=await loginApi(playwright,adminEmail,adminPassword,'playwright-customer-reports-approver');
      viewer=await loginApi(playwright,process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid',
        password,'playwright-customer-reports-viewer');
      for(const session of [author,approver,viewer])expect(session.tenantId).toBe(fixture.tenantId);
      expect(permissionList(author)).toContain('customer_reports:write');
      expect(permissionList(approver)).toContain('customer_reports:approve');
      expect(permissionList(viewer)).toContain('customer_portal:read');
      expect(permissionList(viewer)).not.toContain('customer_reports:export');
    });

    await test.step('Entwurf aus echten Fachdaten und Vier-Augen-Freigabe',async()=>{
      const createdCustomer=await approver!.context.post('/api/v1/customers',{
        headers:approver!.headers,data:{name:`E2E Kundenbericht GmbH ${runId}`,customer_status:'active'},
      });
      customerId=String((await readJson(createdCustomer,'Kunde anlegen')).id);
      const linked=await approver!.context.post(`/api/v1/customers/${customerId}/sites`,{
        headers:approver!.headers,data:{site_id:siteId,relationship_type:'operational'},
      });
      expect(linked.status()).toBe(201);

      const createdIncident=await approver!.context.post('/api/v1/einsatz/incidents',{
        headers:approver!.headers,data:{
          incident_type_code:'other',priority_id:fixture.priorityId,
          description:`E2E Kundenbericht ${runId}. ${confidentialNote}`,
          customer_id:customerId,site_id:siteId,source:'e2e-customer-reports',
          source_key:`e2e-customer-report-${runId}`,client_mutation_id:randomUUID(),
        },
      });
      const incident=await readJson(createdIncident,'Einsatz anlegen');
      incidentId=String(incident.id);
      expect(createdIncident.status()).toBe(201);

      const preview=await author!.context.get('/api/v1/customer-reports/preview/incidents',{
        headers:author!.headers,params:{...reportFilters(),customer_id:customerId,site_id:siteId,page:1,page_size:25},
      });
      const previewBody=await readJson(preview,'Kundenberichtsvorschau');
      expect(previewBody.filter.timezone).toBe('Europe/Berlin');
      expect(Number(previewBody.filter.total)).toBeGreaterThan(0);
      const projected=previewBody.rows.find((row:Row)=>row.id===incidentId);
      expect(projected).toBeTruthy();
      expect(Object.keys(projected).sort()).toEqual([
        'category','id','label','metric','occurred_at','site_id','site_name','status',
      ]);
      expect(JSON.stringify(previewBody.rows)).not.toContain(confidentialNote);

      const draft=await author!.context.post('/api/v1/customer-reports/releases',{
        headers:author!.headers,data:{title,kind:'incidents',customer_id:customerId,
          filters:{...reportFilters(),site_id:siteId}},
      });
      const draftBody=await readJson(draft,'Kundenberichtsentwurf');
      releaseId=String(draftBody.id);
      expect(draft.status()).toBe(201);
      expect(draftBody.status).toBe('draft');
      expect(draftBody.row_count).toBeGreaterThan(0);
      expect(draftBody.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      const submitted=await author!.context.post(`/api/v1/customer-reports/releases/${releaseId}/submit`,{
        headers:author!.headers,data:{},
      });
      expect((await readJson(submitted,'Einreichung')).status).toBe('in_review');

      await errorJson(await author!.context.post(`/api/v1/customer-reports/releases/${releaseId}/approve`,{
        headers:author!.headers,data:{},
      }),403,'Selbstfreigabe');

      const approved=await approver!.context.post(`/api/v1/customer-reports/releases/${releaseId}/approve`,{
        headers:approver!.headers,data:{},
      });
      expect((await readJson(approved,'Freigabe')).status).toBe('approved');
    });

    await test.step('Kundenportal nur mit freigegebenem Schnappschuss',async()=>{
      const list=await viewer!.context.get('/api/v1/customer-portal/releases',{
        headers:viewer!.headers,params:{customer_id:customerId},
      });
      const listBody=await readJson(list,'Kundenportal-Liste');
      expect(listBody.read_only).toBe(true);
      expect(listBody.export_allowed).toBe(false);
      expect((listBody.releases as Row[]).some(row=>row.id===releaseId)).toBeTruthy();

      const detail=await viewer!.context.get(`/api/v1/customer-portal/releases/${releaseId}`,{
        headers:viewer!.headers,
      });
      const detailBody=await readJson(detail,'Kundenportal-Detail');
      expect(detailBody.export_allowed).toBe(false);
      expect(detailBody.read_only).toBe(true);
      expect(JSON.stringify(detailBody.rows)).not.toContain(confidentialNote);
      expect(JSON.stringify(detailBody.rows)).not.toContain('description');

      await errorJson(await viewer!.context.get(`/api/v1/customer-reports/releases/${releaseId}/export`,{
        headers:viewer!.headers,params:{format:'csv'},
      }),403,'Export mit Kundenportal-Lesezugriff');

      for(const format of ['csv','pdf','xlsx']){
        const exported=await approver!.context.get(`/api/v1/customer-reports/releases/${releaseId}/export`,{
          headers:approver!.headers,params:{format},
        });
        expect(exported.status(),`Export ${format}: HTTP ${exported.status()}`).toBe(200);
        expect(Number(exported.headers()['x-report-row-count'])).toBeGreaterThan(0);
      }
    });

    await test.step('Kundenportal in der Oberfläche: schreibgeschützt ohne Export',async()=>{
      const portalPage=await page.context().newPage();
      try{
        await loginUi(portalPage,process.env.E2E_VIEWER_EMAIL??'e2e-viewer@example.invalid',password);
        await portalPage.goto(`/customer-reports?customer_id=${customerId}`);
        await portalPage.getByRole('button',{name:'Kundenportal'}).click();
        await expect(portalPage.getByText('Schreibgeschützte Ansicht ausschließlich freigegebener eigener Berichte. Exporte sind hier bewusst nicht verfügbar.')).toBeVisible();
        await expect(portalPage.getByRole('row',{name:new RegExp(title)})).toBeVisible();
        await portalPage.screenshot({path:'docs/QA/screenshots/customer-reports-viewer-portal-e2e.png',fullPage:true});
        await portalPage.getByRole('row',{name:new RegExp(title)}).getByRole('button',{name:'Öffnen'}).click();
        await expect(portalPage.getByText('Exportfunktionen sind im Kundenportal nicht enthalten.')).toBeVisible();
        await expect(portalPage.getByRole('button',{name:/exportieren/i})).toHaveCount(0);
        await portalPage.screenshot({path:'docs/QA/screenshots/customer-reports-viewer-portal-detail-e2e.png',fullPage:true});
      }finally{
        await portalPage.close();
      }
    });

    await test.step('Tabletbreite: deutsche Oberfläche und Freigabeansicht',async()=>{
      await page.setViewportSize({width:768,height:1024});
      await logoutUi(page);
      await loginUi(page,adminEmail,adminPassword);
      await page.goto(`/customer-reports?customer_id=${customerId}`);
      await expect(page.getByRole('heading',{name:'Kundenberichte und Nachweise'})).toBeVisible();
      for(const name of ['Bericht erstellen','Entwürfe und Freigaben','Kundenportal'])
        await expect(page.getByRole('button',{name})).toBeVisible();
      await page.getByRole('button',{name:'Entwürfe und Freigaben'}).click();
      const ownRow=page.getByRole('row',{name:new RegExp(title)});
      await expect(ownRow).toBeVisible();
      await ownRow.getByRole('button',{name:'Details'}).click();
      await expect(page.getByRole('dialog',{name:title})).toBeVisible();
      await expect(page.getByRole('button',{name:'CSV exportieren'})).toBeVisible();
      await expect(page.getByRole('button',{name:'PDF exportieren'})).toBeVisible();
      await expect(page.getByRole('button',{name:'XLSX exportieren'})).toBeVisible();
      await page.screenshot({path:'docs/QA/screenshots/customer-reports-admin-tablet-release-e2e.png',fullPage:true});
    });

    await test.step('Widerruf entzieht dem Portal sofort den Zugriff',async()=>{
      const revoked=await approver!.context.post(`/api/v1/customer-reports/releases/${releaseId}/revoke`,{
        headers:approver!.headers,data:{reason:`E2E Widerruf ${runId}`},
      });
      expect((await readJson(revoked,'Widerruf')).status).toBe('revoked');
      await errorJson(await viewer!.context.get(`/api/v1/customer-portal/releases/${releaseId}`,{
        headers:viewer!.headers,
      }),404,'Widerrufener Bericht im Kundenportal');
    });

    await test.step('Desktopbreite: Bericht in der deutschen Oberfläche erreichbar',async()=>{
      await page.setViewportSize({width:1440,height:900});
      await page.goto(`/customer-reports?customer_id=${customerId}`);
      await expect(page.getByRole('heading',{name:'Kundenberichte und Nachweise'})).toBeVisible();
      await expect(page.getByRole('button',{name:'Bericht erstellen'})).toBeVisible();
      await expect(page.getByRole('button',{name:'Entwürfe und Freigaben'})).toBeVisible();
      await expect(page.getByRole('button',{name:'Kundenportal'})).toBeVisible();
      await page.getByRole('button',{name:'Entwürfe und Freigaben'}).click();
      await expect(page.getByRole('row',{name:new RegExp(title)})).toBeVisible();
      await page.screenshot({path:'docs/QA/screenshots/customer-reports-admin-desktop-releases-e2e.png',fullPage:true});
    });
  }finally{
    for(const session of [author,approver,viewer])await session?.context.dispose();
  }
});
