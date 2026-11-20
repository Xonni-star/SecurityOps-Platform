import {hashChain,verifyHash} from '../src/services/watchbook-integrity.js';

describe('watchbook integrity hashing',()=>{
  const value={entry_id:'entry',revision_no:1,content:'test',status:'open'};
  it('is deterministic and detects content changes',()=>{
    const first=hashChain(value,null);
    expect(verifyHash(value,null,first.contentHash,first.chainHash,first.integrityHmac)).toBe(true);
    expect(verifyHash({...value,content:'changed'},null,first.contentHash,first.chainHash,first.integrityHmac)).toBe(false);
  });
  it('binds each revision to its predecessor',()=>{
    const first=hashChain(value,null);
    const second=hashChain({...value,revision_no:2},first.chainHash);
    expect(second.chainHash).not.toBe(first.chainHash);
    expect(verifyHash({...value,revision_no:2},first.chainHash,second.contentHash,second.chainHash,second.integrityHmac)).toBe(true);
    expect(verifyHash({...value,revision_no:2},null,second.contentHash,second.chainHash,second.integrityHmac)).toBe(false);
  });
});
