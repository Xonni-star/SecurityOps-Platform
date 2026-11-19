import {Request,Response,NextFunction} from 'express'; import jwt from 'jsonwebtoken'; import {env} from '../config/env.js'; import {AuthUser,Role} from '../types/models.js';
declare global {namespace Express {interface Request {user?:AuthUser}}}
export function requireAuth(req:Request,res:Response,next:NextFunction){const h=req.headers.authorization; if(!h?.startsWith('Bearer ')) return res.status(401).json({error:'Authentication required'}); try {req.user=jwt.verify(h.slice(7),env.JWT_SECRET) as AuthUser; next();} catch{return res.status(401).json({error:'Invalid token'});}}
export function requireRole(...roles:Role[]){return (req:Request,res:Response,next:NextFunction)=>req.user&&roles.includes(req.user.role)?next():res.status(403).json({error:'Insufficient permissions'});}
