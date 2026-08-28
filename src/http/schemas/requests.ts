import { z } from 'zod';

export const organizationSchema=z.object({id:z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),name:z.string().min(2).max(160),school:z.string().min(2).max(160),heelLifeUrl:z.string().url().optional(),websiteUrl:z.string().url().optional(),instagramHandle:z.string().min(2).max(80).optional(),linkedinUrl:z.string().url().optional()}).strict();
export const ingestUrlSchema=z.object({organizationId:z.string().min(2).max(80),url:z.string().url().max(2_048)}).strict();
export const screenshotSchema=z.object({organizationId:z.string().min(2).max(80),base64:z.string().min(4),mimeType:z.enum(['image/png','image/jpeg','image/webp']),note:z.string().max(2_000).optional(),url:z.string().url().optional(),publishedAt:z.string().datetime({offset:true}).optional()}).strict();
export const developmentLoginSchema=z.object({email:z.string().email(),displayName:z.string().min(1).max(120).optional()}).strict();

export function validateScreenshotBytes(base64:string,mimeType:string,maxBytes:number):Buffer{
  const bytes=Buffer.from(base64,'base64');if(bytes.length===0||bytes.length>maxBytes)throw new Error('Screenshot size is invalid');
  const signatures:Record<string,(b:Buffer)=>boolean>={
    'image/png':b=>b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/jpeg':b=>b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff,
    'image/webp':b=>b.length>=12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP',
  };
  if(!signatures[mimeType]?.(bytes))throw new Error('Screenshot bytes do not match the declared type');return bytes;
}
