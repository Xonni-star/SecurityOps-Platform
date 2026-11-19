import {IncomingMessage} from 'node:http';
import {getSessionUser,readCookie,SESSION_COOKIE} from './middleware/auth.js';
export async function authenticateWebSocketRequest(req:IncomingMessage){const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${SESSION_COOKIE}=`));return getSessionUser(cookie?decodeURIComponent(cookie.slice(SESSION_COOKIE.length+1)):undefined);}
