import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpath,stat} from 'node:fs/promises';
export interface RecordCodec {
  getDuration(filePath: string): Promise<number>;
  convertToNTSilkTct?(inputPath: string, outputPath: string): Promise<void>;
}
/** Load only a module explicitly supplied by the consumer, never download a codec. */
export async function loadRecordCodec(modulePath: string): Promise<RecordCodec> {
  if(typeof modulePath!=='string'||!isAbsolute(modulePath)) throw new Error('recordCodecPath must be an absolute local module path');
  const file=await realpath(modulePath);
  if(!(await stat(file)).isFile()) throw new Error('recordCodecPath must identify a module file');
  const imported=await import(pathToFileURL(file).href);
  const codec=typeof imported.getDuration==='function'?imported:imported.default;
  if(!codec||typeof codec.getDuration!=='function') throw new Error('Record codec must export getDuration(filePath)');
  if(codec.convertToNTSilkTct!==undefined&&typeof codec.convertToNTSilkTct!=='function') throw new Error('Record codec convertToNTSilkTct must be a function');
  return codec;
}
