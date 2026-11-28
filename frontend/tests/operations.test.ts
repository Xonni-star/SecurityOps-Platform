/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it,vi} from 'vitest';

const fetchMock=vi.hoisted(()=>vi.fn());
vi.mock('../src/lib/api',()=>({
  ApiError:class ApiError extends Error{
    constructor(message:string,public status:number,public fields:Record<string,string>={},public reasonCode?:string){
      super(message);this.name='ApiError';
    }
  },
  api:vi.fn(),hasPermission:vi.fn(),csrf:()=>'csrf',storedUser:()=>null,
}));

import {ApiError} from '../src/lib/api';
import {
  alertMeasureSource,asArray,display,errorText,field,isForbidden,isSourceOpen,matchesSearch,
  numberOrNull,pagedGet,query,text,
} from '../src/lib/operations';

const response=(body:unknown,headers:Record<string,string>={})=>({
  ok:true,status:200,
  headers:{get:(name:string)=>headers[name]??headers[name.toLowerCase()]??null},
  json:async()=>body,
});

beforeEach(()=>{fetchMock.mockReset();vi.stubGlobal('fetch',fetchMock);});

describe('operative frontend helpers',()=>{
  it('serialises only meaningful filter values',()=>{
    expect(query({date:'2026-11-27',site_id:'',page:2,overdue:false,customer_id:null,q:'Alarm'}))
      .toBe('date=2026-11-27&page=2&overdue=false&q=Alarm');
  });

  it('reads envelopes and pagination headers without inventing totals',async()=>{
    fetchMock.mockResolvedValueOnce(response({items:[{id:'m-1'},{id:'m-2'}]},{
      'X-Total-Count':'27','X-Page-Count':'14',
    }));
    expect(await pagedGet('/operations/measures',['items'])).toEqual({rows:[{id:'m-1'},{id:'m-2'}],total:27,pages:14});
    fetchMock.mockResolvedValueOnce(response([{id:'m-3'}]));
    expect(await pagedGet('/operations/measures')).toEqual({rows:[{id:'m-3'}],total:1,pages:1});
    fetchMock.mockResolvedValueOnce({ok:false,status:403,json:async()=>({error:'Kein Zugriff'})});
    await expect(pagedGet('/operations/measures')).rejects.toMatchObject({status:403,message:'Kein Zugriff'});
  });

  it('detects forbidding and source_open responses explicitly',()=>{
    expect(isForbidden(new ApiError('Kein Zugriff',403))).toBe(true);
    expect(isForbidden(new Error('Kein Zugriff'))).toBe(false);
    expect(isSourceOpen(new ApiError('Ursache besteht weiterhin',409,{},'source_open'))).toBe(true);
    expect(isSourceOpen(new ApiError('Die Ursache besteht weiterhin',409))).toBe(true);
    expect(isSourceOpen(new ApiError('Ungültige Eingabe',400))).toBe(false);
    expect(errorText(new Error('Backendfehler'))).toBe('Backendfehler');
    expect(errorText(null)).toContain('Bitte versuchen Sie es erneut');
  });

  it('maps alert sources to the allowed measure source types and keeps stable keys',()=>{
    const suffix='00000000-0000-4000-8000-000000000099';
    expect(alertMeasureSource({
      priority:'critical',code:'active_alarm',title:'Alarm',description:'',recommendation:'',
      site_id:suffix,site_name:'Objekt',employee_id:null,employee_name:null,shift_id:null,period:null,
      detected_at:null,link:`/einsatz/alarme/${suffix}`,source_key:`alarm:${suffix}`,
    })).toEqual({source_key:`alarm:${suffix}`,module:'einsatz',priority:'critical',source_type:'alarm',source_id:suffix});
    expect(alertMeasureSource({
      priority:'high',code:'missing',title:'Nachweis',description:'',recommendation:'',
      site_id:suffix,site_name:'Objekt',employee_id:null,employee_name:null,shift_id:null,period:null,
      detected_at:null,link:'/dms',source_key:`document:${suffix}`,
    })).toMatchObject({module:'dokument',source_type:'document',source_id:suffix});
    expect(alertMeasureSource({
      priority:'medium',code:'hazard',title:'Gefährdung',description:'',recommendation:'',
      site_id:suffix,site_name:'Objekt',employee_id:null,employee_name:null,shift_id:null,period:null,
      detected_at:null,link:`/sites/${suffix}`,source_key:`hazard:${suffix}`,
    })).toMatchObject({module:'objekt',source_type:'site',source_id:suffix});
    expect(alertMeasureSource({
      priority:'low',code:'absence',title:'Abwesenheit',description:'',recommendation:'',
      site_id:null,site_name:null,employee_id:null,employee_name:null,shift_id:null,period:null,
      detected_at:null,link:'/scheduling',source_key:`absence:${suffix}`,
    })).toEqual({source_key:`absence:${suffix}`,module:'mitarbeiter',priority:'low'});
  });

  it('reads loosely shaped rows and searches case-insensitively in German',()=>{
    const row={title:'Schlüsselrückgabe',count:'12',empty:'',nothing:null};
    expect(field(row,['empty','title'])).toBe('');
    expect(display(row,['nothing','title'],'–')).toBe('Schlüsselrückgabe');
    expect(numberOrNull(row.count)).toBe(12);
    expect(numberOrNull('nicht numerisch')).toBeNull();
    expect(text(undefined,'–')).toBe('–');
    expect(asArray({measures:[row,null]},['measures','rows'])).toEqual([row]);
    expect(matchesSearch(row,'SCHLÜSSEL')).toBe(true);
    expect(matchesSearch(row,'Alarm')).toBe(false);
  });
});
