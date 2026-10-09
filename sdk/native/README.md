# macOS N-API registration bridge

QQ 7.0.2-53644 arm64 wrapper.node imports `qq_magic_napi_register` through dynamic lookup. The QQNT framework exports that symbol at the same implementation as standard `napi_module_register`. Ordinary Node does not provide the alias. The bridge forwards a standard `napi_module` descriptor to Node's registrar.

Load this bridge first using `process.dlopen(module, path, RTLD_NOW | RTLD_GLOBAL)`, then load wrapper.node normally. This is ordinary Node in the same process; it does not load QQNT, run Electron, or need DYLD_INSERT_LIBRARIES.

Build with `node scripts/build-native.ts`. The build requires clang and Node C headers. `QQ_NODE_INCLUDE` selects a headers directory. Generated output is `native/darwin-<arch>/registration-bridge.node`.

Verified on macOS arm64, Node 24.19.0, QQ wrapper 7.0.2-53644: loads and returns 104 exports, process exits normally. This proves loading only, not engine initialization or login. Other platforms and wrapper versions require independent verification. The wrapper still needs its original dependent dynamic libraries and resources. Forwarding does not supply all lazily resolved optional symbols, so individual features can still fail.

Do not forward `qq_magic_node_register` blindly: legacy Node/V8 registration requires a matching module ABI. wrapper.node's verified path uses N-API. This local major.node loads directly under Node and exports `load`; it does not require this alias.

Engine initialization and QR generation were subsequently verified in an ordinary unsandboxed Node worker. Inside the Codex filesystem sandbox, Disk Arbitration can return NULL for `/dev/disk0`; this wrapper then calls `CFRelease(NULL)` and traps during machine GUID discovery. The identical probe succeeds outside that sandbox. No CoreFoundation interception or identity fabrication is needed. The optional missing `PerfTrace` hook did not prevent QR generation.

`node scripts/export-local-native.ts` copies the local wrapper dependency closure into `.local/native/qq-<version>-darwin-<arch>`, includes complete signed framework bundles, dereferences source symlinks, and generates a SHA-256 mirror manifest. It does not copy QQ user data or application scripts. Signed frameworks need their resource and signature metadata; copying only their executable produces code-signature load failures. Local copied-package loading was verified without referencing QQ.app dependency paths.

Linux arm64 and x64 QQ 3.2.32-52194 wrappers also loaded under ordinary Node24.20. The same N-API bridge supplies the alias, and its `preloadLibrary("libgnutls.so.30")` method supplies libbugly's missing global GnuTLS symbols. Public `createClient` generated QR PNGs on both architectures. See `docs/linux-runtime.md` for prerequisites, exact evidence limits and reproduction. Linux account login and services remain unverified.
