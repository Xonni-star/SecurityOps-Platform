import {describe,expect,it,jest} from '@jest/globals';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBackupTargetAdapter} from '../src/services/backup-adapters.js';
import {retryUpload} from '../src/services/backup.js';

describe('backup adapters and retry',()=>{
  it('writes only under the configured local target and can remove its own artifact',async()=>{
    const root=await mkdtemp(join(tmpdir(),'securityops-backup-'));
    try{
      const adapter=createBackupTargetAdapter('local',{root});
      await adapter.upload({key:'tenant/run/file.dump',content:Buffer.from('backup')});
      expect(await readFile(join(root,'tenant/run/file.dump'),'utf8')).toBe('backup');
      await adapter.delete('tenant/run/file.dump');
      await expect(readFile(join(root,'tenant/run/file.dump'))).rejects.toThrow();
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('retries failed uploads and succeeds only after an actual adapter success',async()=>{
    const adapter={upload:jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(undefined),delete:jest.fn()};
    await expect(retryUpload(adapter,{key:'a',content:Buffer.from('x')},3)).resolves.toBe(2);
    expect(adapter.upload).toHaveBeenCalledTimes(2);
  });
});
