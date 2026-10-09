import assert from 'node:assert/strict';
import test from 'node:test';
import {gzipSync} from 'node:zlib';
import {buildForwardResourceRequest,normalizeForwardResourceId,parseForwardResourceResponse} from '../src/forward-resource-wire.ts';
import {buildTextForwardPayload} from '../src/long-message-request.ts';
const h=(hex:string)=>Buffer.from(hex.replaceAll(' ',''),'hex');
// Independent test writer uses bigint shifts (production uses numeric request writer).
function v(n:bigint|number){let b=BigInt(n);const out:number[]=[];while(b>=128n){out.push(Number(b&127n)|128);b>>=7n;}out.push(Number(b));return Buffer.from(out);}
function b(n:number,value:Buffer){return Buffer.concat([v(n*8+2),v(value.length),value]);}
function s(n:number,value:string){return b(n,Buffer.from(value));}
function i(n:number,value:number|bigint){return Buffer.concat([v(n*8),v(value)]);}
function response(raw:Buffer,id='r',gzip=gzipSync(raw)){return b(1,Buffer.concat([s(3,id),b(4,gzip)]));}
function payload(records:Buffer[],extraActions:Buffer[]=[]){return Buffer.concat([b(2,Buffer.concat([s(1,'MultiMsg'),b(2,Buffer.concat(records.map(raw=>b(1,raw))))])),...extraActions]);}
function record(elems:Buffer[],head=h('08 7b 12 01 75 3a 03 32 01 4e'),richExtra=Buffer.alloc(0)){return Buffer.concat([b(1,head),b(2,h('30 07')),b(3,b(1,Buffer.concat([...elems.map(e=>b(2,e)),richExtra])))]);}
const text=h('0a 03 0a 01 41'),face=h('12 02 08 0e');
test('hand-built request hex and scalar input never invoke coercions',()=>{
 assert.equal(buildForwardResourceRequest('u','r').data.toString('hex'),'0a0a0a0312017512017218017a080802100018002000');
 assert.equal(buildForwardResourceRequest('u','r').command,'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg');
 let called=0;assert.throws(()=>normalizeForwardResourceId({toString(){called++;return 'r'}}));assert.equal(called,0);
 for(const value of ['', '\ud800', 'a'.repeat(4097),null,3])assert.throws(()=>normalizeForwardResourceId(value));
 assert.equal(normalizeForwardResourceId('中文'), '中文');
});
test('manual record decodes author/time/plain text/face; preserves raw and opaque fields',()=>{
 const mentioned=b(1,Buffer.concat([s(1,'@A'),b(3,h('01'))]));const opaque=h('9a030178');
 const rawRecord=record([text,face,mentioned,opaque],undefined,b(3,h('0801'))),raw=payload([rawRecord]);
 const out=parseForwardResourceResponse(response(raw),'r');
 assert.deepEqual(out.records[0].sender,{userId:'123',uid:'u',nickname:'N'});assert.equal(out.records[0].time,7);
 assert.deepEqual(out.records[0].elements.slice(0,2),[{type:'text',text:'A'},{type:'face',id:14}]);
 assert.deepEqual(out.records[0].elements.slice(2).map(e=>e.type==='unknown'?e.fieldNumbers:[]),[[1],[51],[3]]);
 assert.deepEqual(out.records[0].raw,rawRecord);assert.deepEqual(out.raw,raw);
 const input=response(raw);const result=parseForwardResourceResponse(input,'r');input.fill(0);assert.deepEqual(result.raw,raw);
});
test('independent text-only encoder payload interoperates for private and group records',()=>{
 for(const target of [{type:'private' as const},{type:'group' as const,groupUin:456}]){
 const raw=buildTextForwardPayload({selfUid:'self',target,nodes:[{senderUin:4294967295,displayName:'名字',timeSeconds:42,text:'你好 🌍',sequence:0}]});
 const result=parseForwardResourceResponse(response(raw),'r');assert.deepEqual(result.records[0].sender,{userId:'4294967295',nickname:'名字'});assert.equal(result.records[0].time,42);assert.deepEqual(result.records[0].elements,[{type:'text',text:'你好 🌍'}]);
 }
 assert.deepEqual(parseForwardResourceResponse(response(payload([])),'r').records,[]);
});
test('rejects malformed wire, duplicate singulars, identity mismatch and ambiguous actions',()=>{
 const good=payload([record([text])]);
 const bad=[h('80'),h('0a80'),h('0a8000'),h('00'),h('0b'),h('ffffffffffffffffff02'),Buffer.concat([response(good),response(good)]),response(good,'wrong')];
 for(const input of bad)assert.throws(()=>parseForwardResourceResponse(input,'r'));
 assert.throws(()=>parseForwardResourceResponse(response(payload([], [b(2,Buffer.concat([s(1,'MultiMsg'),b(2,Buffer.alloc(0))]))])),'r'),/multiple/);
 assert.throws(()=>parseForwardResourceResponse(response(payload([record([b(1,Buffer.concat([s(1,'a'),s(1,'b')]))])])),'r'),/duplicate/);
 assert.throws(()=>parseForwardResourceResponse(response(payload([record([b(1,b(1,h('ff')))])])),'r'),/UTF-8/);
 assert.throws(()=>parseForwardResourceResponse(response(payload([record([b(2,i(1,2147483648))])])),'r'),/integer/);
 assert.throws(()=>parseForwardResourceResponse(response(b(2,s(1,'Other'))),'r'),/missing MultiMsg/);
});
test('gzip is single member with exact trailer, bounded output and no trailing bytes',()=>{
 const raw=payload([]),z=gzipSync(raw);
 for(const zip of [z.subarray(0,z.length-1),Buffer.concat([z,h('00')]),Buffer.concat([z,z])])assert.throws(()=>parseForwardResourceResponse(response(raw,'r',zip),'r'));
 const crc=Buffer.from(z);crc[crc.length-8]^=1;assert.throws(()=>parseForwardResourceResponse(response(raw,'r',crc),'r'),/checksum/);
 assert.throws(()=>parseForwardResourceResponse(response(raw,'r',gzipSync(Buffer.alloc(16*1024*1024+1))),'r'),/oversized/);
 assert.throws(()=>parseForwardResourceResponse(Buffer.alloc(8*1024*1024+1),'r'),/size/);
});
test('whole batches reject excessive records/elements and retain extras without fake identities',()=>{
 assert.throws(()=>parseForwardResourceResponse(response(payload(Array.from({length:1001},()=>record([])))),'r'),/record count/);
 assert.throws(()=>parseForwardResourceResponse(response(payload([record(Array.from({length:1001},()=>text))])),'r'),/element count/);
 assert.throws(()=>parseForwardResourceResponse(response(payload(Array.from({length:11},()=>record(Array.from({length:1000},()=>text))))),'r'),/element count/);
 const unknown= parseForwardResourceResponse(response(payload([b(3,b(1,b(4,h('0801'))))])),'r').records[0];
 assert.deepEqual(unknown.sender,{});assert.equal(unknown.time,undefined);assert.equal(unknown.elements[0].type,'unknown');
});

test('canonical uint64 and parsed-field budget are enforced',()=>{
 const good=payload([]);
 const max=i(99,18446744073709551615n);
 assert.deepEqual(parseForwardResourceResponse(response(Buffer.concat([good,max])),'r').records,[]);
 assert.throws(()=>parseForwardResourceResponse(response(Buffer.concat([good,h('98068000')])),'r'),/noncanonical/);
 assert.throws(()=>parseForwardResourceResponse(response(Buffer.concat([good,h('9806ffffffffffffffffff02')])),'r'),/overflow/);
 assert.throws(()=>parseForwardResourceResponse(response(Buffer.concat([good,...Array.from({length:100001},()=>i(99,0))])),'r'),/field count/);
});

test('group sender context wins without falling back to friend nickname',()=>{
 const friend=b(7,s(6,'friend')),group=b(8,s(4,'group'));
 const both=Buffer.concat([i(1,123),friend,group]);
 assert.equal(parseForwardResourceResponse(response(payload([record([],both)])),'r').records[0].sender.nickname,'group');
 const missing=Buffer.concat([i(1,123),friend,b(8,i(1,456))]);
 assert.equal(parseForwardResourceResponse(response(payload([record([],missing)])),'r').records[0].sender.nickname,undefined);
});
test('response accepts regular Buffers only without overridden buffer method calls',()=>{
 let calls=0;const input=response(payload([]));
 Object.defineProperty(input,'subarray',{value(){calls++;throw Error('must not call')}});
 assert.throws(()=>parseForwardResourceResponse(input,'r'),/size\/type/);assert.equal(calls,0);
 const inherited=response(payload([]));Object.setPrototypeOf(inherited,Object.create(Buffer.prototype,{subarray:{value(){calls++;throw Error('must not call')}}}));
 assert.throws(()=>parseForwardResourceResponse(inherited,'r'),/size\/type/);assert.equal(calls,0);
 assert.deepEqual(parseForwardResourceResponse(response(payload([])),'r').records,[]);
});
function mention(extra:Buffer,additional=Buffer.alloc(0)){return b(1,Buffer.concat([s(1,'@fixture'),b(12,extra),additional]));}
function common(service:number,inner:Buffer,business=0){return b(53,Buffer.concat([i(1,service),b(2,inner),i(3,business)]));}
function decodedElement(element:Buffer){return parseForwardResourceResponse(response(payload([record([element])])),'r').records[0].elements[0];}
test('manual mentions preserve all, UID-only, UIN-only and both identities without lookup',()=>{
 const fixtures=[
  [mention(Buffer.concat([i(3,1),i(4,0),i(5,0),s(9,'')])),{userId:'all'}],
  [mention(Buffer.concat([i(3,2),i(4,0),i(5,0),s(9,'u_exact')])),{uid:'u_exact'}],
  [mention(Buffer.concat([i(3,2),i(4,4294967295)])),{userId:'4294967295'}],
  [mention(Buffer.concat([i(3,2),i(4,123),s(9,'u_exact')])),{userId:'123',uid:'u_exact'}],
 ] as const;
 for(const [raw,identity] of fixtures)assert.deepEqual(decodedElement(raw),{type:'at',text:'@fixture',...identity,raw});
 const raw=payload([record([text,fixtures[1][0],face])]);
 assert.deepEqual(parseForwardResourceResponse(response(raw),'r').records[0].elements.map(e=>e.type),['text','at','face']);
 for(const raw of [mention(i(3,2)),mention(i(3,9)),mention(Buffer.concat([i(3,2),i(4,0)])),mention(Buffer.concat([i(3,1),i(99,1)])),mention(i(3,1),b(3,h('0000000000000000000000')))])assert.equal(decodedElement(raw).type,'unknown');
});
test('extended face33/37 accept zero IDs and retain metadata raw without animation claims',()=>{
 const small=common(33,Buffer.concat([i(1,0),s(2,'preview'),s(3,'preview2')]),1);
 const big=common(37,Buffer.concat([s(1,'pack'),s(2,'sticker'),i(3,333),i(4,1),i(5,0),s(6,'result'),s(7,'preview'),i(9,1)]),1);
 assert.deepEqual(decodedElement(small),{type:'face',id:0,serviceType:33,businessType:1,raw:small});
 assert.deepEqual(decodedElement(big),{type:'face',id:333,serviceType:37,businessType:1,raw:big});
 assert.equal((decodedElement(common(37,i(3,0))) as {id:number}).id,0);
 for(const raw of [common(99,i(1,1)),common(33,Buffer.alloc(0)),common(33,Buffer.concat([i(1,2),i(99,1)]))])assert.deepEqual(decodedElement(raw),{type:'unknown',fieldNumbers:[53],raw});
 const input=response(payload([record([big])]));const projected=parseForwardResourceResponse(input,'r').records[0].elements[0];input.fill(0);assert.deepEqual('raw' in projected?projected.raw:undefined,big);
});
test('projected mention/extended face reject duplicate/wrong wire/UTF8/range without partial output',()=>{
 const invalid=[
  mention(Buffer.concat([i(3,1),i(3,1)])),mention(s(3,'1')),
  mention(Buffer.concat([i(3,2),i(4,4294967296)])),mention(Buffer.concat([i(3,2),b(9,h('ff'))])),
  mention(Buffer.concat([i(3,2),s(9,'u'.repeat(4097))])),mention(Buffer.concat([i(3,1),i(5,2147483648)])),
  common(33,Buffer.concat([i(1,1),i(1,2)])),common(33,s(1,'1')),
  common(33,i(1,4294967296)),common(37,i(3,2147483648)),common(37,i(3,18446744073709551615n)),
  common(37,Buffer.concat([i(3,2),b(1,h('ff'))])),
 ];
 for(const raw of invalid)assert.throws(()=>parseForwardResourceResponse(response(payload([record([text,raw])])),'r'));
 const negativeMetadata=common(37,Buffer.concat([i(3,14),i(5,18446744073709551615n)]));assert.equal(decodedElement(negativeMetadata).type,'face');
});
test('mention raw is independent and unknown extra text/common metadata is not discarded',()=>{
 const raw=mention(Buffer.concat([i(3,2),i(4,123),s(9,'u_exact')]));
 const input=response(payload([record([raw])]));const result=parseForwardResourceResponse(input,'r');
 const at=result.records[0].elements[0];assert.equal(at.type,'at');assert.notEqual('raw' in at?at.raw:undefined,raw);
 input.fill(0);result.raw.fill(0);result.records[0].raw.fill(0);assert.deepEqual('raw' in at?at.raw:undefined,raw);
 const extraText=mention(i(3,1),s(2,'lint'));
 const extraCommon=b(53,Buffer.concat([i(1,33),b(2,i(1,14)),i(99,0)]));
 for(const element of [extraText,extraCommon])assert.deepEqual(decodedElement(element),{type:'unknown',fieldNumbers:element===extraText?[1]:[53],raw:element});
});
test('duplicate reserve/common scalars and invalid signed service/unsigned business reject',()=>{
 const invalid=[
  b(1,Buffer.concat([s(1,'@A'),b(12,i(3,1)),b(12,i(3,1))])),
  b(53,Buffer.concat([i(1,33),i(1,33),b(2,i(1,14))])),
  b(53,Buffer.concat([i(1,33),b(2,i(1,14)),i(3,1),i(3,1)])),
  b(53,Buffer.concat([i(1,33),b(2,i(1,14)),s(3,'1')])),
  b(53,Buffer.concat([i(1,2147483648),b(2,i(1,14))])),
  b(53,Buffer.concat([s(1,'33'),b(2,i(1,14))])),
  common(33,i(1,14),4294967296),
 ];
 for(const element of invalid)assert.throws(()=>parseForwardResourceResponse(response(payload([record([text,element])])),'r'));
 // A valid negative int32 is an unsupported service, not a fabricated face.
 const unsupported=b(53,Buffer.concat([i(1,18446744073709551615n),b(2,i(1,14))]));
 assert.deepEqual(decodedElement(unsupported),{type:'unknown',fieldNumbers:[53],raw:unsupported});
});
