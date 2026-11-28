import {useEffect,useRef} from 'react';

/**
 * Gemeinsamer Realtime-Refresh für die operativen Seiten.
 * Abonniert den vorhandenen WebSocket unter /ws, filtert relevante Ereignisse,
 * drosselt Refreshes und beendet Socket sowie Timer zuverlässig beim Verlassen.
 * Ein Reconnect ist bewusst begrenzt, damit keine Endlosschleife entsteht.
 */
export function useRealtimeRefresh(
  onRefresh:()=>void|Promise<void>,
  eventPrefixes:string[],
  enabled=true,
  intervalMs=30_000,
){
  const refreshRef=useRef(onRefresh);
  const prefixesRef=useRef(eventPrefixes);
  refreshRef.current=onRefresh;
  prefixesRef.current=eventPrefixes;

  useEffect(()=>{
    if(!enabled)return;
    let disposed=false;
    let socket:WebSocket|null=null;
    let reconnectTimer:number|undefined;
    let throttleTimer:number|undefined;
    let lastRefresh=0;
    let attempts=0;

    const trigger=()=>{
      if(disposed||document.visibilityState!=='visible')return;
      const now=Date.now();
      if(now-lastRefresh>=1000){
        lastRefresh=now;
        void refreshRef.current();
        return;
      }
      if(throttleTimer!==undefined)return;
      throttleTimer=window.setTimeout(()=>{
        throttleTimer=undefined;
        if(disposed||document.visibilityState!=='visible')return;
        lastRefresh=Date.now();
        void refreshRef.current();
      },1000-(now-lastRefresh));
    };

    const interval=window.setInterval(trigger,intervalMs);

    const connect=()=>{
      if(disposed)return;
      try{
        socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws:'}//${location.host}/ws`);
      }catch{
        return;
      }
      socket.onopen=()=>{attempts=0;};
      socket.onmessage=event=>{
        if(disposed)return;
        let type='';
        try{type=String((JSON.parse(String(event.data)) as {type?:unknown}).type??'');}catch{return;}
        if(!type)return;
        if(prefixesRef.current.some(prefix=>type===prefix||type.startsWith(prefix)))trigger();
      };
      socket.onclose=()=>{
        socket=null;
        if(disposed||attempts>=3)return;
        attempts+=1;
        reconnectTimer=window.setTimeout(connect,1_000*attempts);
      };
      socket.onerror=()=>{/* onclose regelt den begrenzten Reconnect */};
    };
    connect();

    return ()=>{
      disposed=true;
      window.clearInterval(interval);
      if(reconnectTimer!==undefined)window.clearTimeout(reconnectTimer);
      if(throttleTimer!==undefined)window.clearTimeout(throttleTimer);
      if(socket){
        socket.onclose=null;
        socket.onmessage=null;
        socket.onerror=null;
        socket.close();
      }
    };
  },[enabled,intervalMs]);
}
