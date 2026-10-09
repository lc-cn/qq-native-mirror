import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateRelease} from '../sdk/scripts/local-first-publish.mjs';
import {verifyVideoMaterialsOnline} from '../sdk/scripts/video-materials.mjs';

export async function verifyVideoRelease(directory,env=process.env,options={}){
 const release=await validateRelease(directory),manifest=release.manifest;
 if(manifest.repository!==env.GITHUB_REPOSITORY||manifest.commit!==env.GITHUB_SHA||manifest.runId!==env.GITHUB_RUN_ID||manifest.runAttempt!==Number(env.GITHUB_RUN_ATTEMPT))throw Error('Video release gate differs from current CI identity');
 if(release.videoMaterialsPending||!release.videoMaterials||release.videoMaterials.pending)throw Error('Permanent corresponding source/relink materials missing');
 await verifyVideoMaterialsOnline(release.videoMaterials,options);
 return {repository:manifest.repository,commit:manifest.commit,runId:manifest.runId,runAttempt:manifest.runAttempt,materialsTag:release.videoMaterials.binding.tag,materialAssets:release.videoMaterials.binding.assets.length,onlineVerified:release.videoMaterials.onlineVerified,npmPublished:false};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 if(process.argv.length!==2)throw Error('Usage: node ci/video-release-gate.mjs');
 console.log(JSON.stringify(await verifyVideoRelease('release')));
}
