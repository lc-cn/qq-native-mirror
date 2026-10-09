/** Owned receive-only projection of fixed multimsg fields. No XML parsing,
 * content fetch, account access, coercion or invocation of property getters. */
import type {ReceivedForwardElement} from './types.ts';
const MAX=1024*1024;
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value)))throw Error('Invalid record');return value as Record<string,unknown>;}
function own(value:unknown,key:string):unknown{const object=record(value),descriptor=Object.getOwnPropertyDescriptor(object,key);if(!descriptor)return undefined;if(!('value'in descriptor))throw Error('Accessor is not data');return descriptor.value;}
function utf8(value:unknown,max:number,nonempty=false):string{if(typeof value!=='string'||(nonempty&&!value)||Buffer.byteLength(value,'utf8')>max)throw Error('Invalid string');for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=value.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))throw Error('Unpaired surrogate');}else if(c>=0xdc00&&c<=0xdfff)throw Error('Unpaired surrogate');}return value;}
function optional(value:unknown,key:string,max=MAX):string|undefined{const object=record(value);if(!Object.hasOwn(object,key))return;return utf8(own(object,key),max);}
export function decodeReceivedForward(element:unknown):ReceivedForwardElement|undefined{
 try{
  const type=own(element,'elementType');
  if(type===16){const native=record(own(element,'multiForwardMsgElement'));const resourceId=utf8(own(native,'resId'),4096,true);const xml=utf8(own(native,'xmlContent'),MAX);const fileName=utf8(own(native,'fileName'),4096);void xml;return{type:'forward',format:'native',resourceId,...(fileName?{cardId:fileName}:{})};}
  if(type!==10)return;
  const ark=record(own(element,'arkElement')),json=utf8(own(ark,'bytesData'),MAX);const document=record(JSON.parse(json));
  if(own(document,'app')!=='com.tencent.multimsg'||own(document,'view')!=='contact')return;
  const detail=record(own(record(own(document,'meta')),'detail'));const resourceId=utf8(own(detail,'resid'),4096,true);
  const result:ReceivedForwardElement={type:'forward',format:'ark',resourceId};
  const uniseq=optional(detail,'uniseq',4096)||undefined,extraValue=own(document,'extra');let filename:string|undefined;
  if(Object.hasOwn(document,'extra')){const extra=record(extraValue);filename=optional(extra,'filename',4096)||undefined;if(Object.hasOwn(extra,'tsum')){const count=own(extra,'tsum');if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0)throw Error('Invalid count');result.count=count;}}
  if(uniseq!==undefined&&filename!==undefined&&uniseq!==filename)return;
  const cardId=uniseq??filename;if(cardId!==undefined)result.cardId=cardId;
  const title=optional(detail,'source'),summary=optional(detail,'summary'),prompt=optional(document,'prompt');if(title!==undefined)result.title=title;if(summary!==undefined)result.summary=summary;if(prompt!==undefined)result.prompt=prompt;
  if(Object.hasOwn(detail,'news')){const news=own(detail,'news');if(!Array.isArray(news)||news.length>1000)throw Error('Invalid previews');const previews:string[]=[];for(let i=0;i<news.length;i++){const descriptor=Object.getOwnPropertyDescriptor(news,String(i));if(!descriptor||!('value'in descriptor))throw Error('Sparse or accessor preview');previews.push(utf8(own(descriptor.value,'text'),MAX));}result.previews=previews;}
  return result;
 }catch{return;}
}
