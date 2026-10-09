import {createHash} from 'node:crypto';
const retryStatus=new Set([429,500,502,503,504]);
class VerificationError extends Error{}
/** Read-only transport retries never relax byte identity. No URLs enter diagnostics. */
export async function verifiedDownload(url,expectedSha256,{maxBytes=512*1024*1024,timeoutMs=120000,proxy,fetch:fetcher=globalThis.fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),stage='native-payload'}={}){
 let source;try{source=new URL(url);}catch{throw new VerificationError('Invalid download contract');}
 if(source.protocol!=='https:'||source.username||source.password||!/^[a-f0-9]{64}$/.test(expectedSha256)||!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw new VerificationError('Invalid download contract');
 if(proxy!==undefined&&proxy!=='https://gh-proxy.com/')throw new VerificationError('Unsupported download proxy');
 if(!/^[a-z0-9-]{1,64}$/.test(stage))throw new VerificationError('Unsafe download stage');
 const failure=category=>new VerificationError(`Download ${category}; stage=${stage}; expectedSha256=${expectedSha256}`);
 for(let attempt=0;attempt<3;attempt++){
  try{
   const request=attempt>0&&proxy?proxy+source.href:source.href;
   const response=await fetcher(request,{signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok){await response.body?.cancel().catch(()=>{});if(!retryStatus.has(response.status))throw failure('HTTP-'+response.status);if(attempt===2)throw failure('retry-exhausted-HTTP-'+response.status);await wait((attempt+1)*500);continue;}
   if(!response.body)throw failure('missing-body');
   const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){await response.body.cancel().catch(()=>{});throw failure('size-limit');}
   const chunks=[];let size=0;
   for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw failure('size-limit');chunks.push(Buffer.from(chunk));}
   const body=Buffer.concat(chunks);
   if(createHash('sha256').update(body).digest('hex')!==expectedSha256)throw failure('checksum');
   return body;
  }catch(error){
   if(error instanceof VerificationError)throw error;
   // Fetch/stream transport exceptions contain unsafe redirect URLs in some runtimes.
   if(attempt===2)throw failure('transport-retry-exhausted');
   await wait((attempt+1)*500);
  }
 }
 throw failure('retry-exhausted');
}
