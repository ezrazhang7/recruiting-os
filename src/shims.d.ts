declare const process: any;
declare const Buffer: any;
type Buffer = any;
declare module 'node:crypto' { export function createHash(...args:any[]): any; export function randomUUID(): string; }
declare module 'node:fs' { export function mkdirSync(...args:any[]): any; }
declare module 'node:path' { export function dirname(...args:any[]): string; }
declare module 'node:sqlite' { export class DatabaseSync { constructor(path:string); exec(sql:string):void; prepare(sql:string):any; close():void; } }
declare module 'node:dns/promises' { export function lookup(...args:any[]): Promise<any[]>; }
declare module 'node:net' { export function isIP(input:string): number; }
declare module 'node:http' { export function createServer(handler:(req:any,res:any)=>any): any; }
declare module 'node:test' { const test:any; export default test; }
declare module 'node:assert/strict' { const assert:any; export default assert; }
