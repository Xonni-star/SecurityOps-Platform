import {spawn,SpawnOptions} from 'node:child_process';
export function spawnFile(command:string,args:string[],options:SpawnOptions){return spawn(command,args,options);}
