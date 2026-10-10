# npm 本地首次发布

先在 GitHub Actions 确认同一次完整 CI 成功，下载该 run 的 `npm-release` 聚合 artifact，解压到独立目录。目录应包含 `release-manifest.json`、7 个 tarball 和 `evidence/` 下 6 个平台消费者验收 JSON 和 `aggregated-main.consumer.json` 主包复验。不要混用不同 run 的文件，不在本地重新打包。

需要加速下载时，维护者可手动运行 `native-npm.yml`，启用 `archive` 并保持 `publish=false`。全部验收通过后，CI 会在 GitHub 创建 `npm-v<version>-ci-<runId>` 预发布，上传七个包、manifest 和 `acceptance-evidence.tar.gz`。包和 evidence 解压后放在同一独立目录，可使用相同校验脚本；下载经过代理也必须通过全部摘要校验。

若完整构建已成功但尚未归档，可手动运行 `archive-npm-candidate.yml`，填写该成功 `native-npm.yml` 的 `source-run-id` 与确切 `source-sha`。GitHub runner 下载原 `npm-release` artifact，校验七包、schema 2 的全部收据摘要及 run/attempt/commit，并再次确认源 run 仍成功且身份未变，再生成同一源 run 的候选 tag。归档工作流的执行编号与源构建编号分别记录；不重新打包 npm tarball、不初始化内核、不登录或发布 npm。校验失败或身份不符时不创建归档。

```sh
node scripts/local-first-publish.mjs /absolute/path/npm-release
```

默认仅校验本地文件，不访问 npm、不登录、不发布。校验包括固定仓库 `lc-cn/qq-native-mirror`、commit/runId/runAttempt、统一版本、准确的 7 个包名与 tarball 名称、size/SHA256/SHA512 integrity、包内 package.json、六个平台的 os/cpu 与 native manifest、manifest 原始字节 hash、消费者 receipt 原始字节 hash，以及各平台和最终聚合主包在 Node 24 下只安装主包后自动选择平台、prepare/close 成功且未尝试登录的证据。主包必须精确 pin 六个辅包的同一版本。

这些摘要证明 artifact 内部一致性。请在 GitHub 页面核对 run 成功、仓库、commit 与 runId；本地 JSON 自身不是 GitHub 签名证明。

完成检查后，先在你的交互终端登录 npm，再使用显式发布开关。网页登录与发布时的验证由你完成：

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
node scripts/local-first-publish.mjs /absolute/path/npm-release --publish
```

脚本按 linux-x64、linux-arm64、darwin-x64、darwin-arm64、win32-x64、win32-arm64、主包顺序发布。发布前只读查询 npm 官方 registry：同版本存在时，只有 `dist.integrity` 与本地 tarball SHA512 完全一致才跳过；不一致立即停止。只有明确的 npm `E404` 才进行新发布，其他网络/鉴权错误停止。发布调用继承终端，让你完成 npm 登录要求与 2FA；脚本不保存、索取或打印 token/OTP。发布禁用包生命周期脚本。

任一失败立即停止，无自动重试。修复问题后可重跑同一 artifact：已发布且摘要一致的包会跳过。首次 7 包完成后，再逐包配置 GitHub Actions Trusted Publisher；此脚本不配置 Trusted Publisher，也不替代 CI 验收。

七个包的 Trusted Publisher 设置均使用 GitHub 用户 `lc-cn`、仓库 `qq-native-mirror`、工作流文件 `native-npm.yml`、环境 `npm-production`。设置完成后，后续版本可手动运行该工作流并启用 `publish`。默认关闭发布，push 仅构建与验收。npm 官方文档：[Trusted publishing](https://docs.npmjs.com/trusted-publishers/)。

聚合 manifest 合同：根字段 `schemaVersion,repository,commit,runId,runAttempt,version,packages`；每个 package 包含 `name,version,tarball,size,sha256,integrity`；辅包额外包含 `manifestSha256,receipt,receiptSha256`，receipt 路径为 `evidence/<platform>-<arch>.consumer.json`。新候选使用 `schemaVersion:2`，增加 `aggregateReceipt:{path:'evidence/aggregated-main.consumer.json',sha256}`。CI 在聚合主包消费者通过后，重新校验七包和全部收据、核对当前 run/commit 身份，再原子写入该摘要；本地校验拒绝缺失声明、其他路径和字节摘要不符。已归档的 schema 1 首发仍兼容；其主收据没有独立 manifest 摘要，由 GitHub evidence 压缩包的资产摘要固定。

## 下载 CI 候选归档

使用 Node 24 和已经可只读访问 GitHub API 的 `gh`。从成功的归档 run 获取确切 prerelease tag：

```sh
node scripts/download-npm-candidate.mjs npm-v0.0.1-ci-RUN_ID /absolute/path/npm-candidate
```

需要资产下载代理时显式添加 `--proxy=https://gh-proxy.com/`；GitHub API 始终由 `gh api` 直接查询，不传给代理。脚本固定仓库、校验 release tag/目标 commit 与成功 CI run 的 SHA、workflow、runAttempt，再核对每个 GitHub asset 的 SHA256。最多并发 3 个有界下载，临时文件校验后原子替换；正确摘要的缓存可跳过，另一 run 禁止复用此目录。代理和重定向不会收到 GitHub API 认证头；脚本不输出 token 或临时签名 URL。

常规验收归档仅接受七个确定名称的普通 JSON 文件，允许至多一个空的 `evidence/` 目录条目，拒绝链接、其他目录、路径穿越和额外条目，然后执行同一 `validateRelease` 校验。此命令不会执行 native、登录或发布。完成后再运行上面的本地首发命令。

## 首发中主包修正

部分辅包已发布后，若主包发现问题，使用 `native-first-main.yml` 手动重验。它从指定的成功候选归档复用六个辅包的原始 tarball，核对源 run、平台及摘要，只编译修正后的主包。不能重新打包已发布的同版本辅包。

六个原生 runner 会禁用 SDK 及子进程创建符号链接，验证仅安装主包后的自动平台选择、初始化和关闭，并用真实原生文件验证镜像缓存首次安装及第二次零文件下载。此流程不登录账号、不发布 npm。聚合主包还会在 Linux 复验。

该候选归档包含 25 份确定名称的 JSON：原七份验收，加上每个平台的 `installed-no-symlink.consumer.json`、`cache-no-symlink.consumer.json`、`source-provenance.json`。manifest 的 `acceptanceEvidence` 绑定新增 18 份文件摘要，`auxiliarySources` 记录原始辅包出处；下载与首发脚本会严格检查所有证据。校验通过后，同一首发脚本跳过摘要一致的已发布辅包，继续发布剩余包和修正后的主包。

账号目录锁与镜像缓存锁使用先完整写入 owner 文件、再原子创建硬链接的方式发布，读取时兼容旧符号链接锁。使用的文件系统须支持同目录硬链接；不要求 Windows 创建符号链接的权限。禁用符号链接的 CI 验收验证这两条 SDK 路径，不替代账号登录或签名真实性验证。

## 0.0.1 本地首发完成（2026-10-09）

七个包均已提交发布并在官方 registry 核对成功：`qq-native-client`，以及 `qq-native-client-{linux,darwin,win32}-{x64,arm64}` 六个辅包。全部 `latest` 为 `0.0.1`，发布摘要与固定候选 [run 37890893656](https://github.com/lc-cn/qq-native-mirror/actions/runs/37890893656) 一致。主包 SHA-256 为 `346bfee5895de2e0ef236cfb25d97654c8b773a5ec5adc67568b79e81301b11a`；已发布辅包字节保持不变。npm 在命令成功后曾提示后台处理，全部入库后才确认首发完成。无需重新发布同版本。

本机从官方 npm 的新缓存只安装主包，自动安装 macOS arm64 辅包；按包名导入、真实内核初始化（104 exports）、关闭和 CLI help 均通过，未触发镜像下载、登录或恢复。六平台官方 npm 安装及镜像路径的独立 [CI 37893553033](https://github.com/lc-cn/qq-native-mirror/actions/runs/37893553033) 已全部通过，回执经过独立核对：官方 metadata/安装 lock 摘要与固定首发候选一致，未安装其他平台辅包，默认内核初始化和关闭成功、CLI help 完整，且镜像第二次初始化零文件下载。Windows 使用 Node 24.20.0，Linux 使用 24.21.0，macOS x64/arm64 分别使用 24.19.0/24.20.0；本轮没有账号登录或恢复。

现在可由 npm 包维护者按前文，为七个包分别配置 Trusted Publisher：GitHub 用户 `lc-cn`、仓库 `qq-native-mirror`、工作流 `native-npm.yml`、环境 `npm-production`。现有工作流默认不发布；后续版本在完整验收后才手动启用发布。首发成功不等于可信发布配置已经完成。

## 0.0.2 候选准备

源码版本与六个辅包的精确 pin 已提升到 `0.0.2`。以下保留早期候选过程；当前生产候选的六平台构建和永久归档已完成，固定来源及下载入口见本文末尾。候选包含首发后的 SDK 查询、事件与生命周期修复。归档不等于 npm 发布，账号验收与签名真实性也不由构建成功证明。

在辅包尚未发布时，源码 lock 的六个 QQ 辅包条目仅声明目标版本、optional、os/cpu，不填写尚未知的 resolved/integrity，也不沿用 0.0.1 的字节摘要。锁定的其他依赖保持原有真实摘要。独立 macOS arm64 构建目录已验证在线及缓存齐备后的离线 `npm ci --ignore-scripts`；此时六个未发布 QQ 辅包没有安装，编译依赖完整。六平台候选 CI 会从固定源逐文件验证并构建辅包，通过独立本地 registry 安装主包验收，release manifest 绑定实际生成包的摘要。七包发布并逐一核对入库后，再用官方 registry 生成这些辅包的完整 lock；这项准备不宣称未知原生包具有已验证的 registry 完整性。

[CI 37925080425](https://github.com/lc-cn/qq-native-mirror/actions/runs/37925080425) 已完成六平台和聚合验收，源 commit 为 `b4b2e4eab5e44f99126e2efc68d6701ac7658833`。296 项回归通过，七份实际安装消费者记录及完整日志已独立核对，schema 2 聚合摘要绑定成功，npm 发布跳过。另一归档 run `37925110570` 两次 macOS arm64 原生文件下载返回 HTTP 500；其失败产物不用于候选。后续归档使用成功 run 的原始产物，并保留其源码及 run 身份。

[候选归档 npm-v0.0.2-ci-37925080425](https://github.com/lc-cn/qq-native-mirror/releases/tag/npm-v0.0.2-ci-37925080425) 已由补归档 [run 37926819590](https://github.com/lc-cn/qq-native-mirror/actions/runs/37926819590) 完成。九个 GitHub 资产完整：七包、manifest、证据压缩包；每个 tarball 的资产摘要与成功源 CI 原始文件一致。七包共 347,739,307 字节，主包 277,406 字节，主包 SHA-256 为 `3fb41d3dab3fe7f0dd225f7413b3cb7dbfdf0c80e9efb11bda1ed948020ca908`。本地完整校验通过，七个 receipt 对象逐一与原始 CI 日志匹配；使用 `gh-proxy.com` 的下载校验也通过（已缓存七包，只新下载证据归档，不宣称本轮进行了七包冷下载）。本轮未执行账号操作或 npm 发布，候选的源码身份仍为 `b4b2e4e...`，不是归档工具所在的 commit。

## 包含内置视频组件的候选

新的候选工作流在构建辅包前，为源码和六平台重链接材料建立独立的 `video-npm-vVERSION-ci-RUN-attempt-ATTEMPT` GitHub prerelease。它保留官方 FFmpeg 源码及签名、签名公钥、验签记录、项目 addon 源码、六平台重链接包和材料报告，共十二个资产。每个辅包的 `video/SOURCE-PROVENANCE.json` 绑定该 release、各资产的 SHA256/大小及实际平台二进制；`video/SOURCE-AND-RELINK.txt` 提供可读链接。QQ 原生文件与视频组件的许可分别保留。

这类 npm 候选归档共有十一个资产：原九个，再加 `video-materials-binding.json` 和 `video-materials.json`。下载脚本会把两份材料恢复到 `video-materials/` 下，并按照 release manifest 的 `videoMaterials.binding` / `videoMaterials.report` 路径与摘要核对。旧的九资产、无 codec 候选仍兼容。

不带 `--publish` 的首发命令执行离线检查，不联网验证材料、不登录账号。启用发布后，脚本先匿名检查材料 release 的身份和全部资产的服务端摘要/大小，并下载报告核对实际字节，再进入 npm registry 查询与认证。材料缺失、篡改、不可访问或与辅包二进制不匹配时停止。此检查不重新下载所有大资产，也不证明修改后的 FFmpeg 库兼容性或 QQ 视频真实送达。永久材料流程已由 CI 37962268125 完成远端验收，详情见下文；npm 仍为 0.0.1。

## 准备同批次的原生镜像

已安装辅包与 catalog 回退是两条路径；构建辅包不会自动更新默认 catalog。永久材料与七包候选通过后，可在源码仓库执行：

```sh
node scripts/prepare-npm-native-mirror.mjs /absolute/path/npm-candidate /absolute/path/empty-mirror-stage
```

命令先校验七包、收据、实际 codec 字节和永久材料在线证明。随后只从 tar 的已登记普通文件读取内容，保留 vendor、bridge、codec、源码出处和许可原始字节，生成按内容摘要去重的 gzip 资产、六份 manifest 和 `mirror-plan.json`。每个文件同时声明原始 SHA256/大小与压缩 SHA256；Windows 的精确 Node 版本与构建配置约束保留。准备工具不上传资产、不加载 native、不修改 catalog。

镜像上线仍需上传与远端摘要核对、六平台实际冷下载/初始化/解码/关闭及缓存复用验收，再替换默认 catalog 中同设备/QQ 版本的条目。相同版本不能同时追加两个条目，否则 SDK 会拒绝歧义。旧完整 catalog、原有 manifest 和资产须另行保留供显式回退；准备命令没有完成这些上线步骤。

## 永久材料与镜像候选实际验收（2026-10-10）

[run 37962268125](https://github.com/lc-cn/qq-native-mirror/actions/runs/37962268125) 在源码 `6cae1ec0a5e1bfb03cb7871083915b3d03272347` 上全部通过：六平台视频组件构建和重链接、十二份实际解码记录、七份实际安装消费者、395 项回归及候选归档；npm 发布跳过。永久材料 release 的十二资产元数据与绑定摘要一致，另从空目录实际下载并验证材料报告、官方 FFmpeg 源码及 macOS arm64 重链接包。这不表示本地重新下载了全部十二份材料。

同批次七个 npm tarball 已通过 `gh-proxy.com` 实际冷下载及完整校验。镜像准备从六个辅包生成 415 个去重 gzip 资产和六份 manifest；独立校验解压字节、完整原生合同和源码出处全部通过。Mac 辅包各登记 1,168 个文件，当前保持完整库存；准备工具每包只解压一次，并严格检查 tar 路径、类型、摘要和大小。十六项准备、tar、校验与上传合同测试通过。公开摘要见 `docs/evidence/codec-materials-ci-37962268125.json`。

上传前可执行只读检查：

```sh
node scripts/verify-npm-native-mirror-stage.mjs /absolute/path/npm-candidate /absolute/path/mirror-stage
node scripts/upload-npm-native-mirror.mjs /absolute/path/npm-candidate /absolute/path/mirror-stage
```

第二个命令默认仅输出计划；加 `--upload` 才创建独立 prerelease。上传工具在重新校验后，把全部已批准字节复制到私有临时目录，再交给 `gh`，避免上传期间重新读取变化的 stage 文件。它仅尝试一次创建；失败须只读核对远端状态，不自动重试或覆盖。成功后核对所有资产元数据和八份小文件实际下载摘要。候选 catalog 指向该 release 的不可变 manifest；工具不修改默认 catalog，也不发布 npm。六平台镜像冷消费者验收、默认 catalog 提升、真实账号视频送达及签名真实性仍待各自的实际证据。

候选镜像的真实六平台消费者使用 `codec-mirror-consumer.yml`，固定绑定成功源 run `37962268125` 和同批次镜像 tag。它只安装该候选的主包并省略辅包，让首次 `createClient` 从独立空缓存按实际设备选择镜像；关闭后实际解码三个视频样本，再初始化和关闭一次，要求第二次所有原生 payload（包括 JSON 资源）零下载。Windows 固定 Node 24.20.0，六平台均禁用符号链接创建。脚本不登录、恢复或发送；新增工作流和生成消费者已通过语法检查；实际验收已启动为 run 37967496003，当前记录为运行中，不宣称已通过。

候选镜像 [native-npm-v0.0.2-ci-37962268125-attempt-1](https://github.com/lc-cn/qq-native-mirror/releases/tag/native-npm-v0.0.2-ci-37962268125-attempt-1) 已完成一次上传：423 个资产的远端 SHA256/大小/URL 和八份小文件实际下载摘要均一致。六平台消费者 [run 37967496003](https://github.com/lc-cn/qq-native-mirror/actions/runs/37967496003) 使用工具 commit `69c9af88dc3be9182925816f96b6222f38a6beb7`，实际主包与原生字节仍绑定成功源 `6cae1ec0a5e1bfb03cb7871083915b3d03272347`。默认 catalog 保持原样；须等待这次消费者结果再提升，不把上传成功视为运行通过。

首次候选镜像消费者 run `37967496003` 六平台均失败于首次 catalog 请求，尚未完成原生初始化。原因已通过只读请求复现：release catalog 资产返回 HTTP 302，而 SDK 的 catalog 请求要求直接响应。源包绑定及安装已通过，不能将此失败归因于原生平台支持。

修正使用 commit `2a65a6c0f2e15fe3da207ed1bcb6d9df4a7c940d` 中的独立 `candidates/native-npm-v0.0.2-ci-37962268125-attempt-1/catalog.json`。候选 catalog 内容与已批准 `mirror-plan.json` 的 `catalogUpdates` 完全一致；六份 manifest 位于包含各自摘要的仓库路径。原 release 中的 catalog 作为审计资产保留，其下载 URL 不能直接作为本版 SDK 的 `catalogUrl`。只读绑定模式已实际通过，六份 raw manifest 实际 HTTP 200 和字节摘要全部匹配。默认 catalog 未修改。修正后的真实消费者需要重新运行，不复用首次失败结果。

修正后的候选入口已通过 [run 37968322910](https://github.com/lc-cn/qq-native-mirror/actions/runs/37968322910)，六平台均真实冷下载、首次 `createClient` 初始化/关闭、自动 codec 解码三个样本和第二次 payload 零请求/零字节。六份实际收据、解码记录、完整日志及 CI 终态经过独立核对，源主包仍固定为 `6cae1ec...` 的候选。

默认 `catalog.json` 现在原位替换六条同设备/QQ版本记录，指向上述已校验的 codec 镜像；两条 Linux `3.2.31-51102` 保留，没有添加歧义版本。替换后 catalog SHA256 为 `ae486c9ffd96d12377f626377243baaa17b45a7afee9bfaa3134ce9fa73b9719`。旧 catalog 原字节备份位于 `catalog-backups/29fd6b763a1323ddcb9a71b1b369188fdc2bf8d7bc4133c19dcc41de8bd60ee7.json`，旧 manifest 和资产继续保留。需要旧完整镜像时，可显式将 `catalogUrl` 指向该备份的 raw GitHub URL；这不是 SDK 自动失败回退。

默认入口另行使用消费者工作流 `mode=default` 验收：实际 `createClient` 不传 wrapper、version、manifest 或 catalog；仍省略安装辅包，以确保使用默认 catalog。候选入口通过不替代这次默认路径验证。npm 保持 0.0.1，本次没有登录或发送。

默认入口的 [run 37969129032](https://github.com/lc-cn/qq-native-mirror/actions/runs/37969129032) 已实际全部通过，验收源码 `956f67ec88a31208b179edb0671d5ad4f025ddbb`。六平台仅安装固定候选主包、不传任何内核/catalog定位输入，真实冷初始化/关闭、自动解码三个视频样本及第二次零payload下载均通过。收据、原生解码日志、API终态与默认路径源码分支经独立核对，详见 `docs/evidence/codec-default-ci-37969129032.json`。官方npm七包latest再次只读核对仍均为0.0.1；本轮没有发包或账号操作。

## 已归档生产候选（2026-10-10）

后续业务审计已在当前源码修复了资料身份错配和稀疏群申请页问题；以下固定归档保留原始字节，尚未包含修复。下载与原始证据核对仍有效；本地发布应等待修正源码的新生产批次完整验收，不将这份历史候选视为已修正版本。详见[查询修复及证据范围](contact-group-query.md)。

[npm-v0.0.2-ci-38005239931](https://github.com/lc-cn/qq-native-mirror/releases/tag/npm-v0.0.2-ci-38005239931) 保存了成功生产 [run 38005239931](https://github.com/lc-cn/qq-native-mirror/actions/runs/38005239931) 的七个原始 npm tarball。源提交固定为 `7ec1a309da4137c5eef190482c731889f6341392`，run attempt 为 1；原始 tarball 未重新打包。该生产运行已完成六个平台的构建、视频重链接、实际安装消费者和聚合校验，595 项回归通过。归档另外包含原始 manifest、七份原始收据组成的严格证据压缩包及两份原始视频材料 JSON，共 11 个资产、389,087,406 字节。GitHub release ID 为 `408464850`，是已公开的 prerelease，并未成为 latest。

所有 11 个资产的官方 SHA256 和大小均与源产物一致。既有候选下载器也已通过完整七包/schema 2/收据/视频材料校验：5 个小资产（主包、manifest、证据压缩包及两份视频材料 JSON）经显式 `gh-proxy.com` 从远端实际下载，6 个大辅包使用重新校验的原 CI 本地缓存；这次回读不代表七包冷下载。独立审计和父代理复核均逐一重算全部 11 个本地文件摘要，证据解压出的七份收据与源 CI 原始字节相同。[归档证据](evidence/npm-candidate-archive-38005239931.json) 保留具体资产身份、来源与回读范围。

在空目录下载并校验这一固定候选：

```sh
node scripts/download-npm-candidate.mjs npm-v0.0.2-ci-38005239931 /absolute/path/npm-candidate-38005239931 --proxy=https://gh-proxy.com/
node scripts/local-first-publish.mjs /absolute/path/npm-candidate-38005239931
```

不需要代理时省略 `--proxy`。这两个命令不发布 npm、不执行 native、不操作账号。后续本地发布使用前文的显式 `--publish` 流程，维护者自行完成 npm 验证；本次归档没有发起 npm 发布。

同一主包另通过 [run 38009410014](https://github.com/lc-cn/qq-native-mirror/actions/runs/38009410014) 的六平台公开默认镜像实际验收。默认原生镜像仍分别绑定 `6cae1ec...` / run `37962268125`，本次归档未修改默认 catalog。安装、初始化、缓存和媒体解码证据不能代替新版本的真实账号业务验收或签名真实性验证。
