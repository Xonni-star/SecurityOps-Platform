import {jest} from '@jest/globals';

describe('SFTP backup adapter',()=>{
  it('uses password auth and configured port',async()=>{
    const connect=jest.fn().mockResolvedValue(undefined);const put=jest.fn().mockResolvedValue(undefined);const end=jest.fn().mockResolvedValue(undefined);
    jest.unstable_mockModule('ssh2-sftp-client',()=>({default:class{connect=connect;put=put;end=end;delete=jest.fn()}}));
    const {SftpBackupTargetAdapter}=await import('../src/services/backup-adapters.js');
    const adapter=new SftpBackupTargetAdapter({host:'sftp.example',port:2222,remotePath:'backups',hostKeyFingerprint:'SHA256-invalid'},{username:'guard',password:'super-secret'});
    await adapter.upload({key:'tenant/run/file.sql',content:Buffer.from('data')});
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({host:'sftp.example',port:2222,username:'guard',password:'super-secret'}));
    expect(put).toHaveBeenCalledWith(expect.any(Buffer),'backups/tenant/run/file.sql');
    expect(end).toHaveBeenCalled();
  });
  it('rejects missing fingerprint before contacting SFTP',async()=>{
    const connect=jest.fn();jest.unstable_mockModule('ssh2-sftp-client',()=>({default:class{connect=connect;end=jest.fn()}}));
    const {SftpBackupTargetAdapter}=await import('../src/services/backup-adapters.js');
    const adapter=new SftpBackupTargetAdapter({host:'sftp.example',remotePath:'backups'},{username:'guard',password:'secret'});
    await expect(adapter.upload({key:'tenant/file',content:Buffer.from('x')})).rejects.toThrow('Fingerprint');
    expect(connect).not.toHaveBeenCalled();
  });
});
