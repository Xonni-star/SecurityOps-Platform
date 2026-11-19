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
}

export function createTimeScanAdapter(baseUrl:string,accountRef:string,secret:string):TimeScanAdapter{
  return {
    async listWorkTimes(from,to){
      const url=new URL('/work-times',baseUrl);
      url.searchParams.set('account',accountRef);
      url.searchParams.set('from',from.toISOString());
      url.searchParams.set('to',to.toISOString());
      const response=await fetch(url,{headers:{accept:'application/json',authorization:`Bearer ${secret}`}});
      if(!response.ok)throw new Error(`TimeScan returned ${response.status}`);
      const payload=await response.json() as {entries?:TimeScanEntry[]};
      if(!Array.isArray(payload.entries))throw new Error('TimeScan response has no entries');
      return payload.entries;
    },
  };
}
