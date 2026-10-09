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

源码版本与六个辅包的精确 pin 已提升到 `0.0.2`；已发布版本仍为 `0.0.1`。候选包含首发后的 SDK 查询、事件与生命周期修复，仍需同一次六平台构建、聚合消费者和 schema 2 摘要校验完成后才可本地发布。归档不等于 npm 发布，账号验收与签名真实性也不由构建成功证明。

在辅包尚未发布时，源码 lock 的六个 QQ 辅包条目仅声明目标版本、optional、os/cpu，不填写尚未知的 resolved/integrity，也不沿用 0.0.1 的字节摘要。锁定的其他依赖保持原有真实摘要。独立 macOS arm64 构建目录已验证在线及缓存齐备后的离线 `npm ci --ignore-scripts`；此时六个未发布 QQ 辅包没有安装，编译依赖完整。六平台候选 CI 会从固定源逐文件验证并构建辅包，通过独立本地 registry 安装主包验收，release manifest 绑定实际生成包的摘要。七包发布并逐一核对入库后，再用官方 registry 生成这些辅包的完整 lock；这项准备不宣称未知原生包具有已验证的 registry 完整性。

[CI 37925080425](https://github.com/lc-cn/qq-native-mirror/actions/runs/37925080425) 已完成六平台和聚合验收，源 commit 为 `b4b2e4eab5e44f99126e2efc68d6701ac7658833`。296 项回归通过，七份实际安装消费者记录及完整日志已独立核对，schema 2 聚合摘要绑定成功，npm 发布跳过。另一归档 run `37925110570` 两次 macOS arm64 原生文件下载返回 HTTP 500；其失败产物不用于候选。后续归档使用成功 run 的原始产物，并保留其源码及 run 身份。

[候选归档 npm-v0.0.2-ci-37925080425](https://github.com/lc-cn/qq-native-mirror/releases/tag/npm-v0.0.2-ci-37925080425) 已由补归档 [run 37926819590](https://github.com/lc-cn/qq-native-mirror/actions/runs/37926819590) 完成。九个 GitHub 资产完整：七包、manifest、证据压缩包；每个 tarball 的资产摘要与成功源 CI 原始文件一致。七包共 347,739,307 字节，主包 277,406 字节，主包 SHA-256 为 `3fb41d3dab3fe7f0dd225f7413b3cb7dbfdf0c80e9efb11bda1ed948020ca908`。本地完整校验通过，七个 receipt 对象逐一与原始 CI 日志匹配；使用 `gh-proxy.com` 的下载校验也通过（已缓存七包，只新下载证据归档，不宣称本轮进行了七包冷下载）。本轮未执行账号操作或 npm 发布，候选的源码身份仍为 `b4b2e4e...`，不是归档工具所在的 commit。
