# macOS native version research

Research date: 2026-09-30, Asia/Manila.

## Evidence matrix

| Native package | Architecture | Evidence | Result |
| --- | --- | --- | --- |
| QQ 7.0.2-53644 local universal wrapper | arm64 | Actual ordinary Node 24.19.0 loading and isolated package loading | 104 native exports via N-API alias bridge |
| QQ 7.0.2-53644 local universal wrapper | x86_64 | Mach-O symbols and QQNT registrar disassembly only | Same missing `qq_magic_napi_register` alias; QQNT registrar uses standard `napi_module` layout. Runtime/login unverified |
| QQ 6.9.82.40990 | universal DMG advertised | Official historical URL acquisition attempted | HTTP 404; no binary acquired or compatibility claim |
| QQ 6.9.95 dated 260429 | DMG advertised | Official URL acquisition attempted | HTTP 404; no binary acquired or compatibility claim |
| QQ 6.9.36.24402 | DMG historical candidate | Official URL acquisition attempted | HTTP 404; no binary acquired or compatibility claim |

The current universal wrapper SHA-256 is `2e6f79b241c33e88f51cb947d9da6e10e31fc2038304eadf0f652a05642aab1a`. This digest covers both architecture slices, not an individual thin binary.

## Historical sources and acquisition limits

[NapCat v4.17.32 primary release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.17.32) explicitly links [QQ 6.9.82.40990 official DMG](https://dldir1v6.qq.com/qqfile/qq/QQNT/c6cb0f5d/QQ_v6.9.82.40990.dmg). Actual curl requests outside the filesystem sandbox returned HTTP 404 on both `dldir1v6.qq.com` and the alternative `dldir1.qq.com` hostname. The initial sandbox DNS failure was separately bypassed; the HTTP 404 is the acquisition result.

Other official candidate URLs also returned HTTP 404:

- [6.9.95 candidate](https://dldir1v6.qq.com/qqfile/qq/QQNT/Mac/QQ_6.9.95_260429_01.dmg), discovered through [historical version inventory](https://github.com/Rodert/qq-versions/releases).
- [6.9.36 candidate](https://dldir1.qq.com/qqfile/qq/QQNT/82ece724/QQ_v6.9.36.24402.dmg).

No historical download completed; therefore no historical installer digest exists. `.local/research/macos` contains no acquired installer. A working primary URL or a locally owned historical installer is needed for actual old-version inspection. No installed QQ files or account data were modified.

## Current x86_64 static findings

`nm -arch x86_64 -m wrapper.node` shows undefined dynamically looked-up `_qq_magic_napi_register`. QQNT exports that symbol at `0x2cf9f10`; LLDB labels the same function `napi_module_register`. Its instructions read module flags at byte offset 4, filename at offset 8 and module name at offset 24, then construct a 64-byte Node module descriptor. These match the standard N-API registration layout, as in the verified arm64 slice.

This supports building an x86_64 registration bridge, but does not prove execution: a matching x86_64 Node runtime and actual load/init/login probe remain required. Native code signing and complete framework resources also remain necessary.

## Mirror preparation implications

Retain native versions as separate immutable artifacts, indexed by OS, architecture, client version and build number. Pin installer provenance and SHA-256 when an installer is actually available; preserve every exported file's digest in the native manifest. A shared registrar symbol name alone must not promote a version to tested status.

For each available version, record distinct gates: downloaded, statically inspected, native loaded, engine initialized, QR generated, user authorized login, and session restored. Current arm64 loading success does not satisfy another version or architecture's gates. Complete client features require their own probes beyond login.
