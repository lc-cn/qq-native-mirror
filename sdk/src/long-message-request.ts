/** Independently authored narrow wire encoder. Field facts: NapCatQQ
 * 26d7533e0f5800fdff865ab2f2ad7692917e1076; see docs/merged-forward-contract.md.
 * This encodes bytes only. It neither uploads nor establishes native acceptance.
 */
import {gzipSync} from 'node:zlib';
export interface TextForwardNode {senderUin:number;displayName:string;timeSeconds:number;text:string;sequence:number}
export interface TextForwardInput {selfUid:string;target:{type:'private'}|{type:'group';groupUin:number};nodes:TextForwardNode[]}
const MAX=1024*1024;
function exact(value:unknown,keys:string[],label:string):asserts value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw Error(`Invalid ${label} fields`);
}
function uint(value:unknown,label:string,positive=false):number{if(typeof value!=='number'||!Number.isInteger(value)||value<(positive?1:0)||value>0xffffffff)throw Error(`Invalid ${label}: uint32 required`);return value;}
function text(value:unknown,label:string):string{
 if(typeof value!=='string'||value.length===0||Buffer.byteLength(value,'utf8')>MAX)throw Error(`Invalid ${label}: bounded nonempty UTF-8 string required`);
 for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw Error(`Invalid ${label}: unpaired surrogate`);}else if(c>=0xdc00&&c<=0xdfff)throw Error(`Invalid ${label}: unpaired surrogate`);}
 return value;
}
function varint(value:number):Buffer{const bytes:number[]=[];do{const low=value%128;value=Math.floor(value/128);bytes.push(low|(value?128:0));}while(value);return Buffer.from(bytes);}
function scalar(field:number,value:number):Buffer{return Buffer.concat([varint(field*8),varint(value)]);}
function bytes(field:number,value:Uint8Array):Buffer{return concat([varint(field*8+2),varint(value.length),Buffer.from(value)]);}
function string(field:number,value:string):Buffer{return bytes(field,Buffer.from(value,'utf8'));}
function concat(parts:Buffer[]):Buffer{const size=parts.reduce((sum,b)=>sum+b.length,0);if(size>MAX)throw Error('Text forward output exceeds 1 MiB');return Buffer.concat(parts,size);}
function validate(input:unknown):TextForwardInput{
 exact(input,['selfUid','target','nodes'],'input');const selfUid=text(input.selfUid,'selfUid');
 const target=input.target; if(!target||typeof target!=='object')throw Error('Invalid target');
 let selected:TextForwardInput['target'];
 if((target as {type?:unknown}).type==='private'){exact(target,['type'],'private target');selected={type:'private'};}
 else{exact(target,['type','groupUin'],'group target');if(target.type!=='group')throw Error('Invalid target type');selected={type:'group',groupUin:uint(target.groupUin,'groupUin',true)};}
 if(!Array.isArray(input.nodes)||input.nodes.length<1||input.nodes.length>100)throw Error('Text forward requires 1-100 dense nodes');
 let total=0;const nodes=Array.from(input.nodes,(node)=>{exact(node,['senderUin','displayName','timeSeconds','text','sequence'],'node');const value={senderUin:uint(node.senderUin,'senderUin',true),displayName:text(node.displayName,'displayName'),timeSeconds:uint(node.timeSeconds,'timeSeconds',true),text:text(node.text,'text'),sequence:uint(node.sequence,'sequence')};total+=Buffer.byteLength(value.text,'utf8');if(total>MAX)throw Error('Text forward aggregate text exceeds 1 MiB');return value;});
 return {selfUid,target:selected,nodes};
}
function payload(input:TextForwardInput):Buffer{
 const group=input.target.type==='group'?input.target.groupUin:undefined;
 const records=input.nodes.map(node=>{
  const author=concat([scalar(1,node.senderUin),string(2,''),scalar(3,0),scalar(4,0),scalar(5,0),...(group===undefined?[string(6,input.selfUid),bytes(7,string(6,node.displayName))]:[bytes(8,concat([scalar(1,group),string(4,node.displayName),scalar(5,2)]))])]);
  const avatar=`https://q.qlogo.cn/headimg_dl?dst_uin=${node.senderUin}&spec=0&img_type=jpg`;
  const forwarded=concat([scalar(1,0),scalar(2,0),scalar(3,group===undefined?2:1),string(5,avatar),string(6,avatar)]);
  const content=concat([scalar(1,group===undefined?9:82),...(group===undefined?[scalar(2,4),scalar(9,4)]:[]),scalar(5,node.sequence),scalar(6,node.timeSeconds),scalar(10,0),bytes(15,forwarded)]);
  const body=bytes(1,bytes(2,bytes(1,string(1,node.text))));
  return bytes(1,concat([bytes(1,author),bytes(2,content),bytes(3,body)]));
 });
 // LongMsgResult.action(2) → actionCommand(1)/actionData(2) → repeated msgBody(1).
 return bytes(2,concat([string(1,'MultiMsg'),bytes(2,concat(records))]));
}
export function buildTextForwardPayload(input:TextForwardInput):Buffer{return payload(validate(input));}
export function buildTextForwardRequest(input:TextForwardInput):{command:string;data:Buffer}{
 const checked=validate(input),compressed=gzipSync(payload(checked),{level:6});
 const group=checked.target.type==='group'?checked.target.groupUin:0;
 const info=concat([scalar(1,group===0?1:3),bytes(2,string(2,group===0?checked.selfUid:String(group))),scalar(3,group),bytes(4,compressed)]);
 const settings=concat([scalar(1,4),scalar(2,1),scalar(3,7),scalar(4,0)]);
 return {command:'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg',data:concat([bytes(2,info),bytes(15,settings)])};
}
