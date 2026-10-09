import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {verifiedDownload} from './verified-download.mjs';
const data=Buffer.from('same immutable bytes'),digest=createHash('sha256').update(data).digest('hex'),url='https://github.com/owner/repo/releases/download/tag/file.gz';
const options={wait:async()=>{}};
test('invalid source URL does not appear in diagnostics',async()=>{await assert.rejects(verifiedDownload('invalid secret=credential',digest),e=>e.message==='Invalid download contract');});
test('500 and network failure retry at most three; explicit fixed proxy preserves URL and digest',async()=>{
 const urls=[];const result=await verifiedDownload(url,digest,{...options,proxy:'https://gh-proxy.com/',fetch:async u=>{urls.push(u);if(urls.length===1)return new Response('temporary',{status:500});if(urls.length===2)throw Error('unsafe signed URL');return new Response(data);}});
 assert.deepEqual(result,data);assert.deepEqual(urls,[url,'https://gh-proxy.com/'+url,'https://gh-proxy.com/'+url]);
});
test('all allowed statuses retry, rejected 4xx and checksum/size errors never retry',async()=>{
 for(const status of [429,500,502,503,504]){let calls=0;await assert.rejects(verifiedDownload(url,digest,{...options,fetch:async()=>{calls++;return new Response('failure',{status});}}),/retry-exhausted/);assert.equal(calls,3);}
 for(const [response,error] of [[()=>new Response('denied',{status:403}),/HTTP-403/],[()=>new Response('wrong'),/checksum/],[()=>new Response(data),/size-limit/],[()=>new Response(data,{headers:{'content-length':'9999'}}),/size-limit/]]){let calls=0;await assert.rejects(verifiedDownload(url,digest,{...options,maxBytes:response().headers.has('content-length')?100:response().status===200&&error.source==='size-limit'?1:100,fetch:async()=>{calls++;return response();}}),error);assert.equal(calls,1);}
});
test('stream transport exhaustion is bounded and errors never reveal URLs',async()=>{let calls=0;await assert.rejects(verifiedDownload(url,digest,{...options,fetch:async()=>{calls++;return new Response(new ReadableStream({start(c){c.error(Error('https://secret.invalid/signed?token=private'));}}));}}),e=>/transport-retry-exhausted/.test(e.message)&&!e.message.includes('secret')&&!e.message.includes('https'));assert.equal(calls,3);await assert.rejects(verifiedDownload(url,digest,{proxy:'https://other.invalid/'}),/Unsupported/);});
test('abort timeout retries bounded transport; empty regular payload remains valid',async()=>{
 let calls=0;
 const alive=setTimeout(()=>{},1000);
 try{await assert.rejects(verifiedDownload(url,digest,{...options,timeoutMs:5,fetch:async(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}),/transport-retry-exhausted/);assert.equal(calls,3);}finally{clearTimeout(alive);}
 const empty=createHash('sha256').update(Buffer.alloc(0)).digest('hex');assert.equal((await verifiedDownload(url,empty,{maxBytes:0,fetch:async()=>new Response(Buffer.alloc(0))})).length,0);
});
