import {describe,expect,it} from '@jest/globals';
import {openapi} from '../src/openapi.js';

type Operation = {security?: Array<Record<string, unknown>>};
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
    ['/dms/documents', 'post', true],
    ['/dms/documents/{documentId}', 'patch', true],
    ['/dms/documents/{documentId}/request-review', 'post', true],
    ['/dms/documents/{documentId}/approve', 'post', true],
    ['/dms/documents/{documentId}/return-for-revision', 'post', true],
  ];

  it.each(endpoints)('documents %s %s with session security', (path, method, requiresCsrf) => {
    const operation = paths[path]?.[method];
    expect(operation).toBeDefined();
    const security = operation?.security ?? [];
    expect(security.length).toBeGreaterThan(0);
    expect(security[0]).toHaveProperty('sessionCookie');
    if (requiresCsrf) expect(security[0]).toHaveProperty('csrfToken');
  });

  it('keeps approval off the generic metadata update description', () => {
    expect(paths['/dms/documents/{documentId}'].patch.summary).toContain('dedicated workflow endpoints');
    expect(paths['/dms/documents'].post.summary ?? '').toBeTruthy();
  });
});
