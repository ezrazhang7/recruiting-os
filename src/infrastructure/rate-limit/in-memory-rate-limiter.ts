import type { RateLimiter, RateLimitResult } from '../../application/ports/rate-limiter';

interface Bucket { count:number;resetAt:number; }
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets=new Map<string,Bucket>();
  constructor(private readonly maxBuckets=10_000){}
  async consume(key:string,limit:number,windowMs:number):Promise<RateLimitResult>{
    const now=Date.now();let bucket=this.buckets.get(key);if(!bucket||bucket.resetAt<=now){bucket={count:0,resetAt:now+windowMs};this.buckets.set(key,bucket);}bucket.count+=1;
    if(this.buckets.size>this.maxBuckets)this.prune(now);
    return{allowed:bucket.count<=limit,remaining:Math.max(0,limit-bucket.count),resetAt:bucket.resetAt};
  }
  private prune(now:number){for(const[key,bucket]of this.buckets){if(bucket.resetAt<=now)this.buckets.delete(key);if(this.buckets.size<=this.maxBuckets)return;}const first=this.buckets.keys().next().value as string|undefined;if(first)this.buckets.delete(first);}
}
