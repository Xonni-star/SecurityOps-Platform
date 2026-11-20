import {describe,expect,it,jest} from '@jest/globals';
import {WebSocket} from 'ws';
import {publish,registerClient} from '../src/services/realtime.js';

function fakeSocket(){
  return {
    readyState:WebSocket.OPEN,
    send:jest.fn(),
    on:jest.fn(),
  } as unknown as WebSocket;
}

describe('WebSocket tenant isolation',()=>{
  it('publishes only to the matching tenant and permission',()=>{
    const tenantASocket=fakeSocket();
    const tenantBSocket=fakeSocket();
    const noPermissionSocket=fakeSocket();
    registerClient(tenantASocket,{id:'a',tenantId:'tenant-a',email:'a@example.invalid',role:'admin',permissions:['alarms:read']});
    registerClient(tenantBSocket,{id:'b',tenantId:'tenant-b',email:'b@example.invalid',role:'admin',permissions:['alarms:read']});
    registerClient(noPermissionSocket,{id:'c',tenantId:'tenant-a',email:'c@example.invalid',role:'viewer',permissions:[]});

    publish('tenant-a','alarm.created',{id:'alarm-a'});

    expect(tenantASocket.send).toHaveBeenCalledTimes(1);
    expect(tenantASocket.send).toHaveBeenCalledWith(expect.stringContaining('"id":"alarm-a"'));
    expect(tenantBSocket.send).not.toHaveBeenCalled();
    expect(noPermissionSocket.send).not.toHaveBeenCalled();
  });
});
