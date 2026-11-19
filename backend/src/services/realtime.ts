import {WebSocket} from 'ws';
import {AuthUser} from '../types/models.js';
const clients = new Set<{socket:WebSocket; user:AuthUser}>();
export function registerClient(socket:WebSocket,user:AuthUser){const client={socket,user};clients.add(client);socket.on('close',()=>clients.delete(client));return client;}
export function publish(tenantId:string,event:string,payload:unknown,permission='alarms:read'){for(const {socket,user} of clients){if(user.tenantId===tenantId&&user.permissions.includes(permission)&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:event,payload,timestamp:new Date().toISOString()}));}}
