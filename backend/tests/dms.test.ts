import net from 'node:net';
import {describe,expect,it} from '@jest/globals';
import {canAccessResource} from '../src/types/authorization.js';
import {ClamAvMalwareScannerAdapter,configuredDmsBackupContract,sha256} from '../src/services/dms-providers.js';
import {canDownloadDmsVersion,nextDmsVersion,retentionDue,scanLifecycle,validateDmsUpload} from '../src/services/dms-domain.js';

describe('DMS domain contracts',()=>{
  it('keeps tenant and site scope isolated',()=>{
    const context={userId:'user-a',tenantId:'tenant-a',role:'operator',isSystemAdmin:false,siteIds:['site-a'],grants:[]};
    expect(canAccessResource(context,'site',{tenantId:'tenant-a',siteId:'site-a'})).toBe(true);
    expect(canAccessResource(context,'site',{tenantId:'tenant-a',siteId:'site-b'})).toBe(false);
    expect(canAccessResource(context,'tenant',{tenantId:'tenant-b'})).toBe(false);
  });
  it('validates size/content type and records a deterministic hash',()=>{
    const content=Buffer.from('hello');
    expect(validateDmsUpload(content,'text/plain',10,new Set(['text/plain']))).toEqual({sizeBytes:5,sha256:sha256(content)});
    expect(()=>validateDmsUpload(content,'application/octet-stream',10,new Set(['text/plain']))).toThrow('Content-Type');
    expect(()=>validateDmsUpload(content,'text/plain',4,new Set(['text/plain']))).toThrow('size');
  });
  it('models quarantine scanning and explicit scan rejection',()=>{
    expect(scanLifecycle({clean:true})).toEqual({state:'available'});
    expect(scanLifecycle({clean:false,signature:'Eicar-Test'})).toEqual({state:'rejected',rejectionReason:'Eicar-Test'});
    expect(canDownloadDmsVersion('active','quarantined')).toBe(false);
    expect(canDownloadDmsVersion('active','available')).toBe(true);
    expect(canDownloadDmsVersion('deleted','available')).toBe(false);
  });
  it('accepts ClamAV clean responses terminated by a NUL byte',async()=>{
    const server=net.createServer(socket=>{socket.resume();socket.on('end',()=>socket.end('stream: OK\0'));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();
    if(!address||typeof address==='string')throw new Error('ClamAV test server did not bind');
    try{
      const scanner=new ClamAvMalwareScannerAdapter('127.0.0.1',address.port,2000);
      await expect(scanner.scan(Buffer.from('clean content'))).resolves.toEqual({clean:true});
    }finally{
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
  it('appends immutable versions and applies retention only when due',()=>{
    expect(nextDmsVersion(undefined)).toBe(1);
    expect(nextDmsVersion(4)).toBe(5);
    expect(retentionDue('2026-01-01T00:00:00Z',new Date('2026-01-02T00:00:00Z'))).toBe(true);
    expect(retentionDue('2026-01-03T00:00:00Z',new Date('2026-01-02T00:00:00Z'))).toBe(false);
  });
  it('exposes an independent blob backup/restore contract',()=>{
    const status=configuredDmsBackupContract();
    expect(status.contractVersion).toBe('dms-blob-backup-v1');
    expect(status.databaseBackupIndependent).toBe(true);
  });
});
