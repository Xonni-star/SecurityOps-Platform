export function uuid():string {
  const cryptoApi=globalThis.crypto;
  if(typeof cryptoApi?.randomUUID==='function') return cryptoApi.randomUUID();
  if(typeof cryptoApi?.getRandomValues==='function'){
    const bytes=new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6]=(bytes[6]&0x0f)|0x40;
    bytes[8]=(bytes[8]&0x3f)|0x80;
    return Array.from(bytes,(byte,index)=>byte.toString(16).padStart(2,'0')+([3,5,7,9].includes(index)?'-':'' )).join('');
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,(char)=>{const value=Math.random()*16|0; const nibble=char==='x'?value:(value&0x3)|0x8; return nibble.toString(16);});
}
