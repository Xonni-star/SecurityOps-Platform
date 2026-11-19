import {describe,it,expect} from 'vitest'; import request from 'supertest'; import {app} from '../src/app.js';
describe('API',()=>{it('reports health',async()=>{const r=await request(app).get('/health');expect(r.status).toBe(200);expect(r.body.status).toBe('ok');});it('protects resources',async()=>{const r=await request(app).get('/api/v1/employees');expect(r.status).toBe(401);});});
