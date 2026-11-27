/** @vitest-environment jsdom */
import {act,cleanup,render} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useRealtimeRefresh} from '../src/lib/useRealtimeRefresh';

class Socket{
  static instances:Socket[]=[];
  onopen:(()=>void)|null=null;
  onmessage:((event:{data:string})=>void)|null=null;
  onclose:(()=>void)|null=null;
  onerror:(()=>void)|null=null;
  closed=false;
  url:string;
  constructor(url:string){this.url=url;Socket.instances.push(this);}
  close(){this.closed=true;}
}

function Consumer({onRefresh,prefixes,enabled=true}:{
  onRefresh:()=>void;prefixes:string[];enabled?:boolean;
}){
  useRealtimeRefresh(onRefresh,prefixes,enabled,60_000);
  return null;
}

beforeEach(()=>{
  cleanup();
  Socket.instances=[];
  vi.stubGlobal('WebSocket',Socket);
  vi.stubGlobal('location',{protocol:'http:',host:'localhost'});
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
});

afterEach(()=>{vi.unstubAllGlobals();});

describe('useRealtimeRefresh',()=>{
  it('subscribes to the existing websocket and refreshes only on relevant events',()=>{
    const refresh=vi.fn();
    render(<Consumer onRefresh={refresh} prefixes={['alarm.','operations.measure.']}/>);
    const socket=Socket.instances[0];
    expect(socket.url).toBe('ws://localhost/ws');
    act(()=>{socket.onmessage?.({data:JSON.stringify({type:'alarm.acknowledged'})});});
    expect(refresh).toHaveBeenCalledTimes(1);
    act(()=>{socket.onmessage?.({data:JSON.stringify({type:'unrelated.event'})});});
    act(()=>{socket.onmessage?.({data:'not json'});});
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('throttles bursts, does not refresh in hidden tabs and closes the socket on unmount',()=>{
    vi.useFakeTimers();
    try{
      vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
      const refresh=vi.fn();
      const mounted=render(<Consumer onRefresh={refresh} prefixes={['incident.']}/>);
      const socket=Socket.instances[0];
      act(()=>{socket.onmessage?.({data:JSON.stringify({type:'incident.created'})});});
      act(()=>{socket.onmessage?.({data:JSON.stringify({type:'incident.updated'})});});
      expect(refresh).toHaveBeenCalledTimes(1);
      act(()=>{vi.advanceTimersByTime(1000);});
      expect(refresh).toHaveBeenCalledTimes(2);
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      act(()=>{socket.onmessage?.({data:JSON.stringify({type:'incident.created'})});});
      expect(refresh).toHaveBeenCalledTimes(2);
      mounted.unmount();
      expect(socket.closed).toBe(true);
      expect(socket.onmessage).toBeNull();
    }finally{
      vi.useRealTimers();
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    }
  });

  it('opens no socket when disabled',()=>{
    render(<Consumer onRefresh={vi.fn()} prefixes={['alarm.']} enabled={false}/>);
    expect(Socket.instances).toHaveLength(0);
  });
});
