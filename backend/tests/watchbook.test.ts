import {describe,expect,it} from '@jest/globals';
import {mergeCorrection} from '../src/services/watchbook.js';

describe('watchbook append-only contracts',()=>{
  const current={categoryId:'category-1',priorityId:'priority-1',content:'Tor geprüft',status:'open' as const};
  it('merges a correction without mutating the prior revision',()=>{
    const next=mergeCorrection(current,{content:'Tor und Zaun geprüft',status:'closed'});
    expect(next).toEqual({...current,content:'Tor und Zaun geprüft',status:'closed'});
    expect(current).toEqual({categoryId:'category-1',priorityId:'priority-1',content:'Tor geprüft',status:'open'});
  });
  it('rejects reopening a closed revision',()=>{
    expect(()=>mergeCorrection({...current,status:'closed'},{status:'open'})).toThrow('nicht wieder geöffnet');
  });
  it('rejects empty corrected content',()=>{
    expect(()=>mergeCorrection(current,{content:'   '})).toThrow('darf nicht leer sein');
  });
});
