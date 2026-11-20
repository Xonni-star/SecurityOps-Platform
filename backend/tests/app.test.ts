import request from 'supertest';
import {app} from '../src/app.js';

describe('API',()=>{
  it('reports health',async()=>{const response=await request(app).get('/health');expect(response.status).toBe(200);expect(response.body.status).toBe('ok');});
  it('reports database-backed readiness',async()=>{const response=await request(app).get('/ready');expect([200,503]).toContain(response.status);});
  it('protects resources',async()=>{const response=await request(app).get('/api/v1/employees');expect(response.status).toBe(401);});
});
