declare module 'nodemailer' {
  type TransportOptions={host:string;port:number;secure:boolean;auth?:{user:string;password?:string}};
  type MailOptions={from:string;to:string;subject:string;text:string};
  function createTransport(options:TransportOptions):{
    sendMail(options:MailOptions):Promise<unknown>;
    verify():Promise<true>;
    close():void;
  };
  export default {createTransport};
}
