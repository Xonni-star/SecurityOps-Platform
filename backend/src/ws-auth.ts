import {IncomingMessage} from 'node:http';
import {allowedOrigins} from './config/env.js';
import {getSessionUser,isAllowedOrigin,readCookieHeader,SESSION_COOKIE} from './middleware/auth.js';
export async function authenticateWebSocketRequest(req:IncomingMessage){if(!isAllowedOrigin(typeof req.headers.origin==='string'?req.headers.origin:undefined,allowedOrigins))return null;return getSessionUser(readCookieHeader(req.headers.cookie,SESSION_COOKIE));}
