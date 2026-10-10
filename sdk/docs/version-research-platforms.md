# Linux / Windows native package research

Initial static snapshot on 2026-09-30: no foreign executable was installed or executed and no account login was attempted in that initial pass. Later Linux native-runtime and account findings are documented separately. Windows findings below are PE file inspection, not runtime support certification. Linux 3.2.32 arm64 and amd64 DEBs were subsequently acquired from GitHub archives and their published SHA-256 hashes verified; see [Linux archive evidence](linux-archives.md). That acquisition pass alone did not verify symbols, dependencies or runtime compatibility; subsequent independent bundle and installed SDK results are recorded in [Linux runtime evidence](linux-runtime.md).

## Primary sources and fixed snapshots

- [NapCat v4.18.28 release](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.28), latest release API snapshot `.local/research/napcat-release.json`, SHA256 `6972d8173037bc0cfa8f8a1800d7df2dd21ccdcf73d82f1393214059e03186ce`.
- [Official Linux download configuration](https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxConfig.js), downloaded snapshot SHA256 `4432f02019da391b0d9594fa300d071dfde69db6d463bd7eef18ca35781a07b8`: Linux version **3.2.34**, update date **2026-09-24**, amd64, arm64, loongarch64; mips64el links version3.2.32.
- [Official Windows download configuration](https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/windowsConfig.js), snapshot SHA256 `59e0c22b493607239c6a874f4357e5b86bc58a45e19ec0f43ea72914759f3012`: NT version **9.9.36**, update date **2026-09-24**, x86, x64, arm64. Do not confuse separate legacy9.7.25 download entry with NT.
- [NapCat initialization fixed commit](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-shell/base.ts), SHA256 `09ddf7032abcf2370d381468c918dc7d48f3e0f82588ce8cff3d03a26c3bdb60`.
- [NapCat v4.10.7 initialization](https://github.com/NapNeko/NapCatQQ/blob/v4.10.7/packages/napcat-shell/base.ts), SHA256 `cc401e7e2f6ae682d3292f4068c38e84caac29a5efd9606c70cc7ea43996bbf6`.

## Download access results

| Source                                  | Requested binary             | Result             |
| --------------------------------------- | ---------------------------- | ------------------ |
| NapCat release Tencent link             | Linux3.2.23-44343 amd64      | HTTP404            |
| Same Tencent v6 CDN                     | Linux3.2.23-44343 arm64      | HTTP404            |
| NapCat release Tencent link             | Windows9.9.26-44343 x64      | HTTP404            |
| NapCat Docker source Tencent link       | Linux3.2.30-50969 amd64      | HTTP404            |
| Official current config                 | Linux3.2.34 arm64            | HTTP403            |
| Current config with browser UA/referrer | Linux3.2.34 arm64            | HTTP403            |
| Equivalent dldir1 CDN pathname          | Linux3.2.34 arm64            | HTTP404            |
| Official current config                 | Windows9.9.36 x64            | HTTP403            |
| NapCat official GitHub release          | Windows.Node packagev4.18.28 | Download succeeded |

Current Linux exact URL: `https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/9ee04bef/QQ_3.2.34_260924_arm64_01.deb`.
Current Windows exact URL: `https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.36/release/e8e54bbb/QQ_9.9.36_260924_x64_01.exe`.

The preserved403 response for the Linux URL is `.local/research/linux-download-headers.txt` and an empty `.local/research/linux-download-error.txt`:

```text
HTTP/1.1 403 Forbidden
Content-Length: 0
X-NWS-LOG-UUID: 1531331370065403207
Connection: keep-alive
Server: Lego Server
Date: Wed, 30 Sep 2026 04:14:06 GMT
X-Cache-Lookup: Return Directly
```

This is a Tencent/CDN-style response; it contains **no ROBOTS_DENIED / proxy denial marker**. The exact access policy cannot be inferred from these headers. Shell DNS required approved network execution; after that, it was HTTP access failure, not DNS failure. HTTP404 is an observed response in this environment, not conclusive proof the archive has been deleted everywhere.

## Windows9.9.31-49738 x64: acquired binary evidence

Source: [NapCat.Shell.Windows.Node.zip](https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.28/NapCat.Shell.Windows.Node.zip). ZIP size **116682798bytes**, SHA256 `fb64fa3b036ad2df1a5d7c204c482694c20e4b763978c8a4968fd3474c05b4a8`. Archive entries dated2026-09-14. Both package.json and config.json identify QQ **9.9.31-49738**, platformwin32, eleArchx64. This release artifact is an upstream prepared package, not a newly downloaded stock Tencent installer; patches may exist.

| File         |      Size | SHA256                                                             |
| ------------ | --------: | ------------------------------------------------------------------ |
| wrapper.node | 104663600 | `a1e59891e743c271d641ee011f47aa887d9f7dfae6b3bb9292a03af759dec203` |
| QQNT.dll     |    481280 | `2f9ae01c30fa624535439cab9ccc2ba56d95e5f2ec85e6182789cb3c9089f3b7` |
| node.exe     |  80511640 | `7447c4ece014aa41fb2ff866c993c708e5a8213a00913cc2ac5049ea3ffc230d` |

`wrapper.node` is **PE32+ x86-64 DLL**, machine0x8664. Its ordinary PE exports contain C++ Session symbols, no standard napi_register_module_v1 export. Its import table imports **qq_magic_napi_register**, many NAPI functions, V8/Node functions and libuv from **QQNT.dll**.

Most significant finding: supplied QQNT.dll has3247 exports, of which3167 are PE forwarders and80 resolve locally (including Node IsEnvironmentStopping and Cr_z_* zlib functions). It is a specialized ABI bridge, not merely a rename of registration symbols. Actual export-forwarder entries:

```text
qq_magic_napi_register -> node.exe.napi_module_register
napi_module_register  -> node.exe.napi_module_register
napi_call_function    -> node.exe.napi_call_function
```

This independently matches the macOS registration bridge concept: native custom registration can be forwarded into Node's standard registration. It is strong static evidence for a Windows pure Node loader path, but cannot establish ABI compatibility with other Node versions. Included node.exe string version is **v22.11.0**; no runtime was executed to verify it or determine whether executable is stock or patched.

Bundle napcat.mjs version map contains `appid:537355830`, `qua:"V1_WIN_NQ_9.9.31_49738_GW_B"` for this exact QQ version. This is a source mapping, not independently extracted from QQ's major.node (none acquired).

Wrapper imported DLL names:

```text
libvips-42.dll libglib-2.0-0.dll libgobject-2.0-0.dll VERSION.dll
QQNT.dll crypto.dll KERNEL32.dll USER32.dll GDI32.dll SHELL32.dll
ole32.dll OLEAUT32.dll ADVAPI32.dll SHLWAPI.dll WS2_32.dll dxgi.dll
gdiplus.dll dwmapi.dll d3d11.dll IMM32.dll WINTRUST.dll CRYPT32.dll
OLEACC.dll IPHLPAPI.DLL NETAPI32.dll ssl.dll dbghelp.dll bcrypt.dll
Secur32.dll WININET.dll RPCRT4.dll POWRPROF.dll broadcast_ipc.dll
```

The package supplies multiple companion libraries, including QQNT.dll, libvips, glib, gobject, broadcast_ipc, ncnn, opencv, QBar, LightQuic and win64 IPC libraries. **crypto.dll and ssl.dll imports are not present as archive entries**; determine their resolution/replacements before calling this dependency closure complete. QQNT.dll itself imports VCRUNTIME140.dll and api-ms-win-crt-runtime-l1-1-0.dll, plus KERNEL32.dll. Full dependency closure includes transitive and dynamically loaded libraries, not only wrapper imports.

Reproducible PE parser script: [scripts/inspect-pe.py](../scripts/inspect-pe.py), research-only standard-library Python (no runtime npm dependency). Run `python3 scripts/inspect-pe.py PATH`; optional `--output REPORT.json`. Structured parsed tables: `.local/research/windows-node/wrapper.pe.json`, `QQNT.pe.json`, and `.local/research/windows-node-v4.15.0/wrapper.pe.json`. All three inspected files were re-parsed successfully with the promoted helper. It covers named exports, forwarders and ordinary imports; delay-load and transitive dependencies remain outside its scope. Executable format was decoded as data on macOS.

## Windows native bridge subset and second-version comparison

The **9.9.31-49738 wrapper imports101 symbols from QQNT.dll**:42 `napi_*`,56 `uv_*`, two C++ symbols (`v8::Isolate::GetCurrent` and `node::IsEnvironmentStopping`), and custom `qq_magic_napi_register`. Of QQNT's80 locally implemented exports, **only IsEnvironmentStopping is directly imported by wrapper**. None of the locally implemented `Cr_z_*` zlib symbols is directly imported by wrapper. Transitive imports must still be inspected before reducing a bridge. NAPI stability alone does not establish compatibility for V8/C++ and libuv symbol imports.

Second acquired source: [NapCat v4.15.0 Windows.Node](https://github.com/NapNeko/NapCatQQ/releases/download/v4.15.0/NapCat.Shell.Windows.Node.zip), size109085152bytes, SHA256 `ec4c3ef18845ffb5627c56f9b6b1c93ecb6058320e9a0003d99684762ae26fd2`. config.json identifies **QQ9.9.23-42086**, archive entries dated2026-02-02. Wrapper96007720bytes, SHA256 `3f3c44136724a88746ccf5c7af06683e03e00587da3a193588e083b0d170f135`. Included QQNT.dll is **byte-identical** to9.9.31-49738 bridge (same481280bytes, SHA256 above), and included node.exe has same80511640byte size (size alone is not hash identity).

Old wrapper imports98 QQNT symbols. New wrapper adds exactly `uv_poll_stop`, `uv_poll_init_socket`, `uv_poll_start`; no old QQNT imports are removed. Both are PE32+ x64 and use `qq_magic_napi_register` through QQNT.dll. Old native companion imports include avif_convert, QBar, opencv and ncnn, while new wrapper directly imports ssl.dll/crypto.dll; dependency packaging therefore **changes even while the bridge remains byte-identical**.

Old bundle's version map: appid537320212, qua`V1_WIN_NQ_9.9.23_42086_GW_B`. New bundle's map: appid537355830, qua`V1_WIN_NQ_9.9.31_49738_GW_B`.

This demonstrates bridge reuse across **two actual prepared Windows binaries**. It does not prove stock Tencent binary compatibility or Windows runtime success. No third download was needed; v4.17.32 metadata was read but asset was not downloaded.

## Session API comparison across source versions

Both NapCatv4.10.7 and current fixed commit use:

1. NodeIQQNTStartupSessionWrapper.create() then NodeIQQNTWrapperSession.getNTWrapperSession('nt_1'), fallback WrapperSession.create().
2. engine.initWithDeskTopConfig and login.initConfig.
3. session.init(config, dependsAdapter, dispatcherAdapter, sessionListener).
4. startupSession.start() if present, else session.startNT(0), then session.startNT() if it throws.
5. onOpentelemetryInit({is_init:true}) as initialization readiness signal.

This verifies the **same compatibility fallback in two source snapshots**, not the behavior of every QQ native version. Separate artifact descriptors should pin exact platform, architecture, QQ version/appid/qua, bridge type, tested Node version, dependency manifest and native file hashes. Do not mark Linux/Windows ready merely because initialization names agree in upstream TypeScript.

The SDK now chooses a complete creation path from callable exports before invoking it. Factory/start errors propagate without selecting another path or retrying a different signature; the older upstream fallback described above is historical source evidence. See [current Session strategy](session-strategy.md). The direct `startNT(0)` path remains compatibility code, without a newly verified Windows argument contract or account-start claim.

## Next runtime evidence needed

Linux: using the acquired 3.2.32 arm64 and amd64 archives, extract without install, inspect ELF NEEDED/imported registration and symbols, use a disposable `node:24` container with read-only native volume and network disabled for export-load proof only. Windows: test captured package on Windows under Node22.11 first, then target Node version; prove load+exports before QR; do not claim system GUI/library dependencies disappear because no QQ window is opened. Cross-account login remains human authorized.
