# npm 本地首次发布

先在 GitHub Actions 确认同一次完整 CI 成功，下载该 run 的 `npm-release` 聚合 artifact，解压到独立目录。目录应包含 `release-manifest.json`、7 个 tarball 和 `evidence/` 下 6 个平台消费者验收 JSON 和 `aggregated-main.consumer.json` 主包复验。不要混用不同 run 的文件，不在本地重新打包。

需要加速下载时，维护者可手动运行 `native-npm.yml`，启用 `archive` 并保持 `publish=false`。全部验收通过后，CI 会在 GitHub 创建 `npm-v<version>-ci-<runId>` 预发布，上传七个包、manifest 和 `acceptance-evidence.tar.gz`。包和 evidence 解压后放在同一独立目录，可使用相同校验脚本；下载经过代理也必须通过全部摘要校验。

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

聚合 manifest 合同：根字段 `schemaVersion:1,repository,commit,runId,runAttempt,version,packages`；每个 package 包含 `name,version,tarball,size,sha256,integrity`；辅包额外包含 `manifestSha256,receipt,receiptSha256`，receipt 路径为 `evidence/<platform>-<arch>.consumer.json`。

## 下载 CI 候选归档

使用 Node 24 和已经可只读访问 GitHub API 的 `gh`。从成功的归档 run 获取确切 prerelease tag：

```sh
node scripts/download-npm-candidate.mjs npm-v0.0.1-ci-RUN_ID /absolute/path/npm-candidate
```

需要资产下载代理时显式添加 `--proxy=https://gh-proxy.com/`；GitHub API 始终由 `gh api` 直接查询，不传给代理。脚本固定仓库、校验 release tag/目标 commit 与成功 CI run 的 SHA、workflow、runAttempt，再核对每个 GitHub asset 的 SHA256。最多并发 3 个有界下载，临时文件校验后原子替换；正确摘要的缓存可跳过，另一 run 禁止复用此目录。代理和重定向不会收到 GitHub API 认证头；脚本不输出 token 或临时签名 URL。

验收归档仅接受七个确定名称的普通 JSON 文件，允许至多一个空的 `evidence/` 目录条目，拒绝链接、其他目录、路径穿越和额外条目，然后执行同一 `validateRelease` 校验。此命令不会执行 native、登录或发布。完成后再运行上面的本地首发命令。
