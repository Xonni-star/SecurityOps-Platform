export type TimeScanEntry={
  externalId:string;
  employeeEmail:string;
  startedAt:string;
  endedAt?:string;
  minutes:number;
  metadata?:Record<string,unknown>;
};

export interface TimeScanAdapter{
  listWorkTimes(from:Date,to:Date):Promise<TimeScanEntry[]>;
  verify():Promise<void>;
}

export function createTimeScanAdapter(baseUrl:string,accountRef:string,secret:string):TimeScanAdapter{
  return {
    async verify(){
      const url=new URL('/health',baseUrl);
      url.searchParams.set('account',accountRef);
      const response=await fetch(url,{method:'HEAD',headers:{accept:'application/json',authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error(`TimeScan-Statusprüfung antwortete mit Status ${response.status}`);
    },
    async listWorkTimes(from,to){
      const url=new URL('/work-times',baseUrl);
      url.searchParams.set('account',accountRef);
      url.searchParams.set('from',from.toISOString());
      url.searchParams.set('to',to.toISOString());
      const response=await fetch(url,{headers:{accept:'application/json',authorization:`Bearer ${secret}`}});
      if(!response.ok)throw new Error(`TimeScan antwortete mit Status ${response.status}`);
      const payload=await response.json() as {entries?:TimeScanEntry[]};
      if(!Array.isArray(payload.entries))throw new Error('TimeScan-Antwort enthält keine Einträge');
      return payload.entries;
    },
  };
}
