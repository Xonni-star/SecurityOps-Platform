import {Router} from 'express'; import {z} from 'zod'; import {login,logout} from '../services/auth.js'; import {CSRF_COOKIE,SESSION_COOKIE,requireAuth,requireCsrf} from '../middleware/auth.js'; import {env} from '../config/env.js';
export const authRouter=Router();
const cookieOptions={httpOnly:true,sameSite:'lax' as const,secure:env.NODE_ENV==='production',path:'/'};
authRouter.post('/login',async(req,res,next)=>{try{const {email,password}=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);const result=await login(email,password);if(!result)return res.status(401).json({error:'Invalid credentials'});res.cookie(SESSION_COOKIE,result.sessionId,cookieOptions);res.cookie(CSRF_COOKIE,result.csrfToken,{...cookieOptions,httpOnly:false});res.json({user:result.user,csrfToken:result.csrfToken});}catch(e){next(e);}});
authRouter.post('/logout',requireAuth,requireCsrf,async(req,res,next)=>{try{await logout(req.sessionId);res.clearCookie(SESSION_COOKIE,cookieOptions);res.clearCookie(CSRF_COOKIE,{...cookieOptions,httpOnly:false});res.status(204).send();}catch(e){next(e);}});
authRouter.get('/me',requireAuth,(req,res)=>res.json({user:req.user}));
