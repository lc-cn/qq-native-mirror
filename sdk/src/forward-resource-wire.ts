/** Independently authored bounded wire reader/writer. Field facts: NapCatQQ
 * 26d7533e0f5800fdff865ab2f2ad7692917e1076 action/message/routing/component/element.ts.
 * No transport, identity lookup or native calls. Unknown length-delimited data stays opaque.
 */
import { inflateRawSync } from 'node:zlib';
import type { ForwardResource, ForwardRecord, ForwardResourceElement } from './types.ts';
const MAX_RESPONSE=8*1024*1024, MAX_RAW=16*1024*1024;
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
function fail(message:string):never {throw new Error(`Invalid forward resource: ${message}`);}
function validString(value:unknown,max:number,nonempty=false):string {
 if(typeof value!=='string'||(nonempty&&!value.length)||Buffer.byteLength(value)>max)fail('invalid bounded UTF-8 string');
 for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=value.charCodeAt(++i);if(!(n>=0xdc00&&n<=0xdfff))fail('unpaired surrogate');}else if(c>=0xdc00&&c<=0xdfff)fail('unpaired surrogate');}
 return value;
}
export function normalizeForwardResourceId(value:unknown):string {return validString(value,4096,true);}
function vi(value:number):Buffer {const a:number[]=[];do{const n=value%128;value=Math.floor(value/128);a.push(n|(value?128:0));}while(value);return Buffer.from(a);}
function scalar(n:number,v:number):Buffer{return Buffer.concat([vi(n*8),vi(v)]);}
function bytes(n:number,b:Buffer):Buffer{return Buffer.concat([vi(n*8+2),vi(b.length),b]);}
export function buildForwardResourceRequest(selfUid:string,resourceId:string):{command:string;data:Buffer} {
 const uid=validString(selfUid,4096,true),resid=normalizeForwardResourceId(resourceId);
 const info=Buffer.concat([bytes(1,bytes(2,Buffer.from(uid))),bytes(2,Buffer.from(resid)),scalar(3,1)]);
 return {command:'trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg',data:Buffer.concat([bytes(1,info),bytes(15,Buffer.concat([scalar(1,2),scalar(2,0),scalar(3,0),scalar(4,0)]))])};
}
type Field={number:number;wire:number;value:bigint|Buffer;raw:Buffer};
class Reader {
 count=0;
 fields(data:Buffer,depth=0):Field[] {
  if(depth>16)fail('depth limit');let offset=0;const fields:Field[]=[];
  const readVar=():bigint=>{let value=0n;for(let i=0;i<10;i++){if(offset>=data.length)fail('truncated varint');const b=data[offset++];if(i===9&&b>1)fail('uint64 overflow');value|=BigInt(b&127)<<BigInt(i*7);if(!(b&128)){if(i>0&&b===0)fail('noncanonical varint');return value;}}return fail('varint overflow');};
  while(offset<data.length){if(++this.count>100000)fail('field count limit');const start=offset,tag=readVar();if(tag>0xffffffffn)fail('invalid tag');const number=Number(tag>>3n),wire=Number(tag&7n);if(!number||number>536870911)fail('invalid field number');let value:bigint|Buffer;
   if(wire===0)value=readVar();else if(wire===1||wire===5){const end=offset+(wire===1?8:4);if(end>data.length)fail('truncated fixed field');value=data.subarray(offset,end);offset=end;}
   else if(wire===2){const length=readVar();if(length>BigInt(data.length-offset))fail('truncated bytes');const end=offset+Number(length);value=data.subarray(offset,end);offset=end;}
   else fail('unsupported wire type');fields.push({number,wire,value,raw:data.subarray(start,offset)});
  }return fields;
 }
}
function one(fields:Field[],number:number,wire:number,required=false):Field|undefined {
 const found=fields.filter(f=>f.number===number);if(found.length>1)fail(`duplicate singular field ${number}`);const f=found[0];if(f&&f.wire!==wire)fail(`wrong wire type ${number}`);if(required&&!f)fail(`missing field ${number}`);return f;
}
function singular(fields:Field[],numbers:number[]):void {for(const n of numbers)if(fields.filter(f=>f.number===n).length>1)fail(`duplicate singular field ${n}`);}
function buf(field:Field):Buffer {if(field.wire!==2)fail('expected nested bytes');return field.value as Buffer;}
function str(field:Field):string {try{return utf8.decode(buf(field));}catch{return fail('invalid UTF-8');}}
function uint(field:Field,max=0xffffffffn):number {if(field.wire!==0||typeof field.value!=='bigint'||field.value>max)fail('invalid unsigned integer');return Number(field.value);}
function crc32(b:Buffer):number {let crc=0xffffffff;for(const byte of b){crc^=byte;for(let k=0;k<8;k++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
/** Exactly one gzip member: bounded inflate, trailer CRC/ISIZE and no trailing bytes. */
function inflate(data:Buffer):Buffer {
 if(data.length<18||data[0]!==31||data[1]!==139||data[2]!==8||(data[3]&0xe0))fail('invalid gzip header');const flags=data[3];let p=10;
 if(flags&4){if(p+2>data.length-8)fail('truncated gzip extra');const len=data.readUInt16LE(p);p+=2+len;}
 for(const bit of [8,16])if(flags&bit){while(p<data.length-8&&data[p]!==0)p++;p++;}
 if(p>data.length-8)fail('truncated gzip header');if(flags&2){if(p+2>data.length-8||data.readUInt16LE(p)!==(crc32(data.subarray(0,p))&65535))fail('gzip header checksum');p+=2;}
 let output:Buffer,consumed:number;
 try{const result=inflateRawSync(data.subarray(p),{maxOutputLength:MAX_RAW,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};output=result.buffer;consumed=result.engine.bytesWritten;}catch{return fail('invalid or oversized gzip');}
 const trailer=p+consumed;if(trailer+8!==data.length)fail('gzip multiple members or trailing bytes');if(data.readUInt32LE(trailer)!==crc32(output)||data.readUInt32LE(trailer+4)!==output.length)fail('gzip checksum/size');return output;
}
function unknown(raw:Buffer,fields:Field[]):ForwardResourceElement {return {type:'unknown',fieldNumbers:[...new Set(fields.map(f=>f.number))],raw:Buffer.from(raw)};}
export function parseForwardResourceResponse(input:Buffer,expectedResourceId:string):ForwardResource {
 const expected=normalizeForwardResourceId(expectedResourceId);if(!Buffer.isBuffer(input)||Object.getPrototypeOf(input)!==Buffer.prototype||['length','byteLength','byteOffset','buffer','subarray','valueOf',Symbol.toPrimitive,Symbol.iterator].some(key=>Object.hasOwn(input,key))||input.length>MAX_RESPONSE)fail('response size/type');input=Buffer.from(input);const reader=new Reader();
 const response=reader.fields(input);singular(response,[1,15]);const result=reader.fields(buf(one(response,1,2,true)!),1);singular(result,[3,4]);const resourceId=normalizeForwardResourceId(str(one(result,3,2,true)!));if(resourceId!==expected)fail('resource ID mismatch');
 const raw=inflate(buf(one(result,4,2,true)!));const root=reader.fields(raw,2);const actions=root.filter(f=>f.number===2);let selected:Field[]|undefined;
 for(const action of actions){const fields=reader.fields(buf(action),3);singular(fields,[1,2]);const command=str(one(fields,1,2,true)!);if(command==='MultiMsg'){if(selected)fail('multiple MultiMsg actions');selected=reader.fields(buf(one(fields,2,2,true)!),4);}}
 if(!selected)fail('missing MultiMsg action');const recordFields=selected.filter(f=>f.number===1);if(recordFields.length>1000)fail('record count');let totalElements=0;
 const records:ForwardRecord[]=recordFields.map(field=>{
  const recordRaw=buf(field),record=reader.fields(recordRaw,5);singular(record,[1,2,3]);const sender:ForwardRecord['sender']={};
  const headField=one(record,1,2);if(headField){const head=reader.fields(buf(headField),6);singular(head,[1,2,3,4,5,6,7,8]);const uin=one(head,1,0),uid=one(head,2,2);if(uin){const value=uint(uin);if(value)sender.userId=String(value);}if(uid){const value=str(uid);if(value)sender.uid=value;}
   const group=one(head,8,2),forward=one(head,7,2);let groupName:string|undefined,friendName:string|undefined;for(const [field,groupContext] of [[group,true],[forward,false]] as const){if(field){const names=reader.fields(buf(field),7);singular(names,groupContext?[1,4,5,7]:[6]);const name=one(names,groupContext?4:6,2);if(name){if(groupContext)groupName=str(name);else friendName=str(name);}}}const nickname=group?groupName:friendName;if(nickname!==undefined)sender.nickname=nickname;
  }
  let time:number|undefined;const content=one(record,2,2);if(content){const fields=reader.fields(buf(content),6);singular(fields,[1,2,3,4,5,6,7,8,9,10,12,15]);const f=one(fields,6,0);if(f)time=uint(f);}
  const elements:ForwardResourceElement[]=[];const body=one(record,3,2);if(body){const fields=reader.fields(buf(body),6);singular(fields,[1,2,3]);const rich=one(fields,1,2);if(rich){const fields=reader.fields(buf(rich),7);singular(fields,[1,3,4]);for(const f of fields){
   if(f.number===2){const elementRaw=buf(f),parts=reader.fields(elementRaw,8);singular(parts,[1,2,3,4,5,6,8,9,12,13,16,19,21,31,37,45,51,53]);let projected:ForwardResourceElement|undefined;
    if(parts.length===1&&parts[0].number===1){const text=reader.fields(buf(parts[0]),9);singular(text,[1,2,3,4,11,12]);const value=one(text,1,2);if(text.length===1&&value)projected={type:'text',text:str(value)};}
    if(parts.length===1&&parts[0].number===2){const face=reader.fields(buf(parts[0]),9);singular(face,[1,2,11]);const value=one(face,1,0);if(face.length===1&&value)projected={type:'face',id:uint(value,0x7fffffffn)};}
    elements.push(projected??unknown(elementRaw,parts));
   }else elements.push(unknown(f.raw,[f]));
   if(elements.length>1000||++totalElements>10000)fail('element count');
  }}for(const f of fields)if(f.number!==1){elements.push(unknown(f.raw,[f]));if(elements.length>1000||++totalElements>10000)fail('element count');}}
  return {sender,...(time===undefined?{}:{time}),elements,raw:Buffer.from(recordRaw)};
 });return {resourceId,records,raw:Buffer.from(raw)};
}
