import {describe,expect,it} from '@jest/globals';
import {openapi} from '../src/openapi.js';

type Operation = {security?: Array<Record<string, unknown>>;responses?: Record<string,{description?:string}>};
const paths = openapi.paths as unknown as Record<string, Record<string, Operation>>;

describe('object management OpenAPI coverage', () => {
  const endpoints: Array<[string, string, boolean]> = [
    ['/sites/overview-dashboard', 'get', false],
    ['/sites/{id}/object-context', 'get', false],
    ['/sites/{id}/chronicle', 'get', false],
    ['/sites/{id}/shifts/{shiftId}/eligibility', 'get', false],
    ['/sites/{id}/document-requirements', 'post', true],
    ['/sites/{id}/document-requirements/{requirementId}', 'patch', true],
    ['/sites/{id}/document-requirements/{requirementId}', 'delete', true],
    ['/sites/{id}/maintenance-orders', 'get', false],
    ['/sites/{id}/maintenance-orders', 'post', true],
    ['/maintenance-orders/{id}', 'patch', true],
    ['/maintenance-orders/{id}/complete', 'post', true],
    ['/maintenance-orders/{id}/cancel', 'post', true],
    ['/maintenance-orders/{id}/documents', 'post', true],
    ['/maintenance-orders/{id}/documents/{documentId}', 'delete', true],
    ['/dms/documents', 'get', false],
    ['/dms/documents/query', 'get', false],
    ['/dms/overview', 'get', false],
    ['/dms/documents', 'post', true],
    ['/dms/documents/{documentId}', 'patch', true],
    ['/dms/documents/{documentId}', 'delete', true],
    ['/dms/documents/{documentId}/history', 'get', false],
    ['/dms/documents/{documentId}/archive', 'post', true],
    ['/dms/documents/{documentId}/restore', 'post', true],
    ['/dms/documents/{documentId}/request-review', 'post', true],
    ['/dms/documents/{documentId}/approve', 'post', true],
    ['/dms/documents/{documentId}/return-for-revision', 'post', true],
    ['/customers', 'get', false],
    ['/customers/action-list', 'get', false],
    ['/customers/export', 'get', false],
    ['/customers/bulk', 'post', true],
    ['/customers/{id}/profile', 'get', false],
    ['/customers/{id}/tasks', 'post', true],
    ['/customers/{id}/tasks/{taskId}', 'patch', true],
  ];

  it.each(endpoints)('documents %s %s with session security', (path, method, requiresCsrf) => {
    const operation = paths[path]?.[method];
    expect(operation).toBeDefined();
    const security = operation?.security ?? [];
    expect(security.length).toBeGreaterThan(0);
    expect(security[0]).toHaveProperty('sessionCookie');
    if (requiresCsrf) expect(security[0]).toHaveProperty('csrfToken');
  });

  it('documents all server-side customer list parameters and permission headers', () => {
    const parameters = (paths['/customers'].get as unknown as {parameters:Array<{name:string}>}).parameters;
    expect(parameters.map(parameter=>parameter.name)).toEqual(expect.arrayContaining([
      'q','customer_status','risk_classification','priority','account_manager_employee_id','contract_status','active','sort','dir','page','pageSize',
    ]));
    expect(paths['/customers'].get.responses?.['200']?.description).toContain('X-Total-Count');
  });

  it('keeps approval off the generic metadata update description', () => {
    expect(paths['/dms/documents/{documentId}'].patch.summary).toContain('dafür vorgesehenen Workflow-Endpunkte');
    expect(paths['/dms/documents'].post.summary ?? '').toBeTruthy();
  });
});

describe('operative control centre and incident management OpenAPI coverage', () => {
  const endpoints: Array<[string, string, boolean]> = [
    ['/operations/control-center', 'get', false],
    ['/operations/control-center/candidates', 'get', false],
    ['/operations/measures', 'get', false],
    ['/operations/measures', 'post', true],
    ['/operations/measures/{id}', 'patch', true],
    ['/einsatz/incidents', 'get', false],
    ['/einsatz/incidents', 'post', true],
    ['/einsatz/incidents/{id}', 'get', false],
    ['/einsatz/incidents/{id}', 'patch', true],
    ['/einsatz/incidents/{id}/status', 'post', true],
    ['/einsatz/incidents/{id}/assignments', 'post', true],
    ['/einsatz/incidents/{id}/documents', 'get', false],
    ['/einsatz/incidents/{id}/documents', 'post', true],
    ['/einsatz/incidents/{id}/documents', 'delete', true],
    ['/einsatz/incidents/{id}/report', 'get', false],
    ['/einsatz/incidents/{id}/report', 'patch', true],
    ['/einsatz/incidents/{id}/escalations', 'get', false],
    ['/einsatz/incidents/{id}/escalations', 'post', true],
    ['/einsatz/alarms', 'get', false],
    ['/einsatz/alarms', 'post', true],
    ['/einsatz/alarms/{id}/acknowledge', 'post', true],
    ['/einsatz/alarms/{id}/resolve', 'post', true],
    ['/einsatz/alarms/{id}/history', 'get', false],
    ['/einsatz/measures', 'get', false],
    ['/einsatz/escalation-rules', 'get', false],
    ['/einsatz/escalation-rules/{id}', 'patch', true],
    ['/einsatz/notifications/{incidentId}', 'get', false],
    ['/einsatz/reports', 'get', false],
  ];

  it.each(endpoints)('documents %s %s with session security', (path, method, requiresCsrf) => {
    const operation = paths[path]?.[method];
    expect(operation).toBeDefined();
    const security = operation?.security ?? [];
    expect(security.length).toBeGreaterThan(0);
    expect(security[0]).toHaveProperty('sessionCookie');
    if (requiresCsrf) expect(security[0]).toHaveProperty('csrfToken');
  });

  it('states that document links never expose DMS blobs and incident closure has conditions', () => {
    expect(paths['/einsatz/incidents/{id}/documents'].post.summary).toMatch(/DMS/);
    expect(paths['/einsatz/incidents/{id}/status'].post.description).toMatch(/Abschlussbedingungen/);
    expect(paths['/operations/measures/{id}'].patch.description).toMatch(/source_open/);
  });
});

describe('key management OpenAPI coverage', () => {
  const endpoints: Array<[string, string, boolean]> = [
    ['/keys', 'get', false],
    ['/keys', 'post', true],
    ['/keys/dashboard', 'get', false],
    ['/keys/action-list', 'get', false],
    ['/keys/export', 'get', false],
    ['/keys/inventory-checks', 'get', false],
    ['/keys/inventory-checks', 'post', true],
    ['/keys/{id}', 'get', false],
    ['/keys/{id}', 'patch', true],
    ['/keys/{id}/issue', 'post', true],
    ['/keys/{id}/return', 'post', true],
    ['/keys/{id}/report-loss', 'post', true],
    ['/keys/{id}/loss-reports/{reportId}', 'patch', true],
    ['/keys/{id}/block', 'post', true],
    ['/keys/{id}/reactivate', 'post', true],
    ['/keys/{id}/history', 'get', false],
    ['/keys/{id}/qr', 'get', false],
    ['/keys/{id}/lost', 'post', true],
    ['/keys/{id}/deactivate', 'post', true],
    ['/key-bundles', 'get', false],
    ['/key-bundles', 'post', true],
    ['/key-bundles/{id}', 'get', false],
    ['/key-bundles/{id}/history', 'get', false],
    ['/key-bundles/{id}/items', 'post', true],
    ['/key-bundles/{id}/items/{keyId}', 'delete', true],
    ['/key-bundles/{id}/deactivate', 'post', true],
    ['/key-bundles/{id}/issue', 'post', true],
    ['/key-bundles/{id}/return', 'post', true],
  ];

  it.each(endpoints)('documents %s %s with session security', (path, method, requiresCsrf) => {
    const operation = paths[path]?.[method];
    expect(operation).toBeDefined();
    const security = operation?.security ?? [];
    expect(security.length).toBeGreaterThan(0);
    expect(security[0]).toHaveProperty('sessionCookie');
    if (requiresCsrf) expect(security[0]).toHaveProperty('csrfToken');
  });

  it('documents all server-side key list filters and pagination headers', () => {
    const parameters = (paths['/keys'].get as unknown as {parameters:Array<{name:string}>}).parameters;
    expect(parameters.map(parameter=>parameter.name)).toEqual(expect.arrayContaining([
      'q','status','key_type','site_id','holder_user_id','holder_employee_id','bundle_id','location','sort','dir','page','pageSize',
    ]));
    expect(paths['/keys'].get.responses?.['200']?.description).toContain('X-Total-Count');
  });

  it('removes the stale keys/bundles paths and keeps the key-bundles paths', () => {
    expect(paths['/keys/bundles']).toBeUndefined();
    expect(paths['/keys/bundles/{id}/return']).toBeUndefined();
    expect(paths['/key-bundles']).toBeDefined();
  });

  it('documents that QR tokens carry no secrets and history endpoints are paginated', () => {
    expect(paths['/keys/{id}/qr'].get.summary).toMatch(/kein Geheimnis/i);
    expect((paths['/keys/{id}/history'].get as unknown as {parameters:Array<{name:string}>}).parameters.map(parameter=>parameter.name)).toEqual(
      expect.arrayContaining(['page','pageSize']),
    );
  });
});
