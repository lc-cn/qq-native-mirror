// Applied before both installed SDK and forked worker imports via NODE_OPTIONS.
// npm's own bin installation legitimately uses symlinks on Unix. Deny only
// application/SDK processes; NODE_OPTIONS still reaches every native worker.
if (!/[\\/]npm-cli\.js$/.test(process.argv[1] ?? '')) {
const fs=require('node:fs');
const {syncBuiltinESMExports}=require('node:module');
const error=()=>Object.assign(new Error('CI policy: symlink creation denied'),{code:'EPERM',syscall:'symlink'});
fs.symlinkSync=()=>{throw error();};
fs.symlink=(...args)=>queueMicrotask(()=>args.at(-1)(error()));
fs.promises.symlink=async()=>{throw error();};
syncBuiltinESMExports();

}
