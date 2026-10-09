# Linux QQ historical package archives

Verified on 2026-09-30. Packages were downloaded and listed without installation or execution. This establishes artifact availability, not pure Node compatibility or login support.

## GitHub release archive

[Rodert/qq-versions](https://github.com/Rodert/qq-versions/releases) preserves actual release attachments, rather than only links to Tencent CDN. Release asset metadata and published checksums are third-party provenance; matching them establishes download integrity, not independent Tencent authenticity.

| QQ version/build | Architectures observed | Release |
|---|---|---|
| 3.2.32 / 260812 | amd64, arm64, loongarch64; mips64el asset is 3.2.31 | [20260813 archive](https://github.com/Rodert/qq-versions/releases/tag/qq-packages-20260813-1d08f1d4) |
| 3.2.32 / 260730 | amd64, arm64, loongarch64; mips64el asset is 3.2.31 | [20260730 archive](https://github.com/Rodert/qq-versions/releases/tag/qq-packages-20260730-8b1562d3) |
| 3.2.31 / 260710 | amd64, arm64, loongarch64, mips64el | [20260720 archive](https://github.com/Rodert/qq-versions/releases/tag/qq-packages-20260720-ffedf7c6) |

Only the following two assets were downloaded in this pass. Other rows are confirmed release asset listings.

| Asset | Bytes | Observed SHA-256, matching published digest |
|---|---:|---|
| [3.2.32 arm64 DEB](https://github.com/Rodert/qq-versions/releases/download/qq-packages-20260813-1d08f1d4/QQ_3.2.32_260812_arm64_01.deb) | 205524324 | `8796ccfd66acc025ef18db37185532d40bc8c58921e17da6d28c295acbcf8f92` |
| [3.2.32 amd64 DEB](https://github.com/Rodert/qq-versions/releases/download/qq-packages-20260813-1d08f1d4/QQ_3.2.32_260812_amd64_01.deb) | 185828040 | `d085dd89397225061eb9f194308f688129818ed445777e97a4a0a16e13d7b0e8` |

Local assets: `.local/research/linux-archives/`. Both packages contain `opt/QQ/resources/app/wrapper.node`, `major.node`, `ipc.node`, `AudioFoundation.node`, `iohook.node`, `initIpc_ia32.node`, `initIpc_x64.node` and architecture-specific sharp addon. Native file inventories are saved as `arm64-native-files.json` and `amd64-native-files.json`.

## Additional candidate mirrors

- [Shandong University Spark Store mirror](https://mirrors.sdu.edu.cn/spark-store-repository/store/chat/linuxqq/): directory listing observed; package download and hashes not verified in this pass.
- [openKylin linuxqq package pool](https://software.openkylin.top/openkylin/yangtze/pool/main/deb/linuxqq/): search-index candidate, direct listing not verified.
- [openSUSE weearcm repository](https://download.opensuse.org/pub/opensuse/repositories/home%3A/weearcm/openSUSE_Slowroll/x86_64/): search-index candidate containing Linux QQ RPM, direct package download not verified.

Next compatibility work should inspect ELF architecture, DT_NEEDED, registration symbols and glibc/GLIBCXX requirements, then run an isolated ordinary Node export-load probe on matching Linux CPU architecture. Keep downloaded, load-tested, QR-tested and authenticated evidence distinct in the package catalog.

## Additional acquired and load-tested version

On 2026-09-30, the archived [3.2.31 arm64 DEB](https://github.com/Rodert/qq-versions/releases/download/qq-packages-20260720-ffedf7c6/QQ_3.2.31_260710_arm64_01.deb) was downloaded: 202282552 bytes, SHA-256 `ac604371f5c486acf6cbf83dd667e622ee1f487d0c8bd425627de6d68fe34974`, matching the third-party release digest. The package identifies native client version `3.2.31-51102`; major.node metadata identifies AppID `537376498`. The exporter copied eight ELF-linked files totaling 171653848 bytes, without QQ executable or account data. Wrapper SHA-256: `72978494d18d0076a378550099628569ff5081ada79f37e0b7adaeae6904217a`.

The independent bundle loaded under actual Linux arm64 Node 24.20.0/N-API 10 using the registration bridge and GnuTLS preload. It reported 92 exports and exit status zero. Container networking was disabled and mounts were read-only; no Session preparation, login, signing or account operations were attempted. Receipts: `.local/research/linux-3.2.31-export.json` and `linux-3.2.31-load.json`. This adds a second Linux native version with loading evidence only. Its API driver signatures remain unverified and it is not declared fully supported.

The matching 3.2.31 amd64 DEB was subsequently acquired: 182675698 bytes, SHA-256 `02f677feb1ce01ed293a3c7761e5dd85bd79936f57dcaa4cdb53178ae30e3d6d`, matching the same third-party release's published digest. The independent x64 bundle passed the installed SDK preparation test described in linux-runtime.md; this is not login or signing acceptance.
