import {afterAll} from 'vitest';

declare const setImmediate:(callback:()=>void)=>unknown;

/**
 * React 19 schedules passive effects through setImmediate. When the jsdom
 * environment is disposed before those callbacks run, react-dom reads
 * `window.event` after the window global is gone and Vitest reports an
 * unhandled `ReferenceError: window is not defined`. Draining a few scheduler
 * generations while jsdom is still alive keeps the tests fail-fast for real
 * errors without weakening any assertion.
 */
afterAll(async()=>{
  for(let generation=0;generation<4;generation+=1){
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
});
