declare module 'ssh2-sftp-client' {
  type ConnectionOptions={host:string;port?:number;username:string;password?:string;privateKey?:string;passphrase?:string;readyTimeout?:number;strictVendor?:boolean;hostHash?:string;hostVerifier?:string|((key:string)=>boolean)};
  type PutOptions={};
  export default class SftpClient {
    connect(options:ConnectionOptions):Promise<this>;
    put(input:Buffer|string,remotePath:string,options?:PutOptions):Promise<void>;
    delete(remotePath:string):Promise<void>;
    end():Promise<void>;
  }
}
