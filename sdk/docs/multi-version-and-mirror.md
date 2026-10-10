# 多版本原生内核、通用逻辑与镜像管理方案

历史设计记录：2026-09-30。截至 2026-10-09，schemaVersion=1 的 catalog 自动按 OS/CPU 选最新版、精确版本选择、npm 平台辅包、文件校验和缓存已实现。下文的 schemaVersion=2、独立 driver 注册表和元数据签名仍是设计草案；历史运行记录保留其当时的证据范围。最新实证见本文末节。

## 2026-09-30 取样时的证据与结论

本节表格记录早期取样状态；不代表目前的平台运行状态。当前源码对应的原生 runner 验证见本文后续实证章节。

macOS arm64 / QQ 7.0.2-53644 / Node 24.19.0 已验证普通 Node 加载、扫码授权、账号 Session readiness、独立包和镜像下载后的恢复登录。当前 wrapper 同时有 x64 切片，但 x64 尚未运行验证。其他版本/平台的具体取样结果见 version-research-macos.md 和 version-research-platforms.md。

| 原生样本                         | 获取来源                                | 此次证据                                                                                             |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| macOS 7.0.2-53644 arm64          | 本机 MAS 安装                           | 已加载、二维码、真实授权、Session readiness、镜像恢复                                                |
| macOS 7.0.2-53644 x64            | 同一 universal 二进制                   | 静态符号和注册布局，未运行                                                                           |
| Windows 9.9.23-42086 x64         | NapCat v4.15.0 prepared Node bundle     | 实际 PE 导入与 forwarder 扫描，未运行                                                                |
| Windows 9.9.31-49738 x64         | NapCat v4.18.28 prepared Node bundle    | 实际 PE 导入与 forwarder 扫描，未运行                                                                |
| Linux 3.2.32-52194 arm64 / amd64 | GitHub 归档、文件摘要校验、独立依赖导出 | 两架构已通过安装后的 npm 初始化/关闭；arm64 曾真实扫码 ready，但恢复失败；amd64 未认证               |
| Linux 3.2.31-51102 arm64 / amd64 | GitHub 归档、文件摘要校验、独立依赖导出 | 两架构已通过镜像消费、初始化和关闭（amd64 模拟执行）；两架构已入不可变镜像目录；未登录或验证业务接口 |
| Linux 3.2.34 arm64               | 官方配置已获取；安装包 HTTP 403         | 只有官方版本元数据，未取得原生二进制                                                                 |

两个 Windows 样本复用同一 QQNT.dll（相同 SHA-256）；较新 wrapper 对该 DLL 的导入由 98 增至 101，新增 uv_poll_stop、uv_poll_init_socket、uv_poll_start。新样本导入包含 N-API、libuv，以及 V8/Node C++ 符号，因此需记录匹配的运行时约束，不能单凭 N-API 推断任意 Node 版本兼容。具体来源和哈希见平台研究报告。

不能将“相同版本号”“都有 wrapper.node”或“都引用 N-API”当作兼容结论。Node-API 的 ABI 稳定性不覆盖原生库自己依赖的其他库，也不覆盖任意 Node/V8/Electron 专有 ABI。依据：https://nodejs.org/api/n-api.html#implications-of-abi-stability。

## 通用逻辑如何抽离

先抽离现有稳定逻辑，暂不以尚未验证的版本编写适配实现。

| 层                     | 负责内容                                                               | 不放在这里的内容                     |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| public client          | createClient、login、事件、close、公开错误及账号状态                   | 原生函数名和平台注册符号             |
| Node worker/IPC        | 普通 Node 子进程、请求关联、超时、错误/Buffer 编码、退出及工作目录隔离 | QQ/Electron 宿主启动                 |
| package resolver/cache | 精确版本选择、manifest/包校验、下载、原子安装、并发锁                  | 账号凭据和原生业务配置               |
| platform loader        | 动态库搜索、注册桥、OS/CPU/依赖检查                                    | 登录和 Session 方法选择              |
| kernel driver          | 原生能力检查、版本对应配置、Listener、登录及 Session 启动              | 网络下载、用户 UI 和缓存锁           |
| verification           | 二进制清单、API 指纹、加载/QR/登录/恢复证据                            | 把源码兼容猜测升级为 runtime support |

当前可直接复用的代码：src/index.ts 中的 worker 生命周期、src/native-package.ts 中的下载/校验/缓存、src/worker.ts 的传输边界。src/kernel.ts 目前混合了稳定登录流程和特定原生 API，适合下一轮拆出 driver。native/registration-bridge.c 是 macOS 对应加载策略，不能宣称跨平台通用。

建议 driver 接口保持小：

```ts
interface KernelDriver {
  id: string;
  validateSurface(wrapper: unknown): void;
  initialize(context: KernelContext): Promise<void>;
  login(request: LoginRequest): Promise<Account>;
  close(): Promise<void>;
}
```

这是设计草案。引擎、登录服务、Session 创建/启动、原生配置与 listener mapping 都由 driver 内部管理。已验证使用相同调用契约的多个 QQ build 才共享同一 driver；driver 名称按调用契约命名，避免每个小版本复制整份 kernel。

从 kernel 抽离时保留生命周期：listener 注册 → connect → 登录成功 → Session init/start → readiness 后 login() 返回。不要为了统一方法名而吞掉真实初始化错误；当前宽泛 try/catch fallback 应逐步换成 descriptor 声明的明确路径或导出能力检查。

原生 API 指纹辅助识别接口变化，不能替代运行验证。同样的导出对象和方法名可以对应不同参数结构、行为或网络策略。

## 原生包的身份

Windows 9.9.31-49738 的上游 Node 包已取得：其中 QQNT.dll 约 470 KiB，存在实际 PE export forwarders 将 qq_magic_napi_register 转发给 node.exe.napi_module_register；但 wrapper 还导入 V8/Node/libuv 符号。这个样本说明注册策略可以共享思路，具体 ABI 依赖不能共享假设。该包来自上游准备的 Node bundle，不能等同于原始腾讯安装包；缺少的 crypto.dll/ssl.dll 依赖仍需解决。Windows 当前只有静态证据。

建议独立记录以下维度，而不是只使用 QQ 版本号：

- 产品：qqnt。
- platform：darwin / linux / win32。
- arch：arm64 / x64 等；universal 是二进制格式信息，不等于每个切片都已验证。
- clientVersion 和 build：使用各平台真实版本，不将 Linux 3.2.x 与 Windows 9.9.x 当作同一 semver 序列。
- distribution：mas / official-dmg / official-deb / official-exe 等。相同版本号的不同发行来源可能不同。
- provenance/transform：第三方 prepared-node-bundle 与 stock installer 分开；记录提供者、来源 digest 和已知处理步骤，未知补丁明确标 unknown。不能将第三方修改版的兼容证据挂在 stock 包上。
- revision：原生文件集合或打包布局变化时递增，禁止覆盖既有包。
- wrapper SHA-256 和 manifest SHA-256：区分上游同名替换及重新打包。
- driver ID、registration strategy、native dependency constraints、已验证的 Node 版本。

npm 模块版本、QQ 内核版本、原生包 revision 是三个不同版本轴。例如 npm 0.2.0 可以支持多个经过验证的内核；修改下载器不需要重发所有 QQ 二进制；重新整理签名 framework 内容则需新的 package revision。

## 镜像目录与解析

```text
catalog/v1/index.json
channels/v1/darwin/arm64/stable.json
releases/v1/qqnt/darwin/arm64/7.0.2-53644/mas/r1/manifest.json
objects/sha256/<prefix>/<full-sha256>
evidence/v1/<manifest-sha256>/<verification-id>.json
```

catalog 和 channel 是可变索引；release manifest 和 content-addressed objects 不可变。精确版本解析完成后必须锁定 manifest digest，下一次运行按已锁定版本恢复。不要每次启动自动漂移到 latest。

如果客户端以后自动消费 catalog，建议对 catalog/release metadata 做签名，npm 模块内置可信公钥并校验 key ID。仅在可变 catalog 中放 sha256 不能建立信任：索引和哈希可能一起被替换。现有 v1 API 的 manifestSha256 则由调用者通过可信渠道提供，继续保留该精确锁定入口。

manifest 保留每个文件的原始相对路径，同时 URL 可指向内容寻址对象，因此共享文件可去重。签名 framework 的 Info.plist、Resources、_CodeSignature 及目录布局属于完整依赖包；本项目实际遇到过只复制 executable 后签名校验失败。

当前下载器一次真实验收发出 1157 个请求（manifest + 1156 文件），大部分文件较小。公网分发可随后增加完整 archive transport（如 tar.gz），减少请求往返；解包必须验证路径/链接/文件类型，并按 manifest 复核内容。缓存仍以 manifest digest 为身份。保留 loose-file transport 用于调试，不在当前阶段强行切换格式。

storage backend 可为任意支持 HTTPS 的对象存储/CDN，避免 client 依赖某个云厂商 SDK。公开分发的来源与授权需在发布准备中确认；本次只生成本地研究包，没有发布第三方二进制。

## Descriptor 设计草案

此段是下一版 schema 的草案，当前 v1 下载器不能直接消费。未知约束保持 null，不能填猜测值。

```json
{
  "schemaVersion": 2,
  "package": {
    "product": "qqnt",
    "platform": "darwin",
    "arch": "arm64",
    "clientVersion": "7.0.2-53644",
    "build": "53644",
    "distribution": "mas",
    "revision": 1
  },
  "driver": "nt-session-startup-v1",
  "registration": "qq-magic-napi-alias",
  "runtime": {
    "testedNodeVersions": ["24.19.0"],
    "minimumNapiVersion": null,
    "minimumOsVersion": null,
    "libc": null
  },
  "version": {
    "clientVersion": "7.0.2-53644",
    "appId": "537391652",
    "qua": "V1_MAC_7.0.2-53644_53644_GW_B"
  },
  "entry": "wrapper.node",
  "files": [],
  "evidenceRefs": []
}
```

真实 descriptor 的 files 必须完整。registration 可另有 standard-napi / legacy-node / unknown 等策略；unknown 不自动加载推荐。legacy-node 必须记录并验证 Node/V8 ABI，不能把 qq_magic_node_register 简单转发成 N-API。

Linux 需调查 ELF 的 DT_NEEDED/RPATH、glibc、GLIBCXX 等；Windows 需调查 PE 导入库、CRT 和宿主依赖；macOS 需调查 Mach-O 符号、framework 签名及 OS 约束。这些是研究项，不表示当前二进制已经出现所有上述限制。

镜像只能选择 npm 模块内已实现的 loader/driver ID，不从远端 manifest 下载并执行任意 JS 适配代码。驱动代码随 npm 发布，原生数据包独立分发。

## 校验、证据与发布流程

1. 获取安装包，记录精确来源、时间、完整包 SHA-256、实际版本与发行渠道。
2. 在临时目录解包，扫描 Mach-O/ELF/PE 的架构、注册符号和传递依赖，导出必要原生资源。
3. 为每个 OS/CPU/Node 组合记录 exports 和 prototype 方法指纹。
4. 运行独立 Node 进程加载测试、引擎初始化和二维码测试。
5. 由测试账号授权验证认证、Session readiness、关闭和恢复；不迁移或覆写常用账号的数据目录做升级测试。
6. 检查离开 QQ 安装目录后的运行路径，并从真实镜像 transport 下载验收。
7. 生成不可变 manifest 和验证记录，更新 catalog 中该精确组合的支持状态；只有通过约定验收的条目进入 stable。

建议证据不是单个 supported=true，而是分别记录 downloaded、staticInspected、loaded、qrGenerated、authenticated、sessionReady、restored、packageConsumerVerified，并附测试 OS/CPU/Node、二进制哈希、时间和脱敏记录。认证证据不得包含二维码会话令牌、账号 token 或数据库密钥。

用于本机 API 指纹准备的命令：

```sh
node scripts/record-native-profile.ts /path/to/wrapper.node \
  --load --bridge native/darwin-arm64/registration-bridge.node \
  --output /path/to/profile.json
```

该脚本不会调用登录和业务 API；--load 仍执行原生 initializer，所以使用独立子进程。当前 symbol/dependency 自动解析仅覆盖 Mach-O；其他格式需专用扫描器。静态扫描或加载成功都不会自动标为已登录。

## 下一轮优先顺序

先取得第二个 macOS build 的完整原生包，验证 driver 是否真正复用；再用 Linux arm64 做第一条跨平台纯 Node 探针；随后 Windows x64 调查宿主导入依赖。Node 版本矩阵与 OS 矩阵独立记录。已有版本保持固定，直到新的条目通过验收。

旧版下载链接失效是此次研究遇到的实际限制。因此在镜像正式上线前，先建立原始安装包归档和下载失败记录，再扩展自动适配。

## 可执行的镜像目录准备

运行 `node scripts/stage-native-mirror.ts SOURCE_NATIVE_DIR MIRROR_DIR`。源目录必须包含现有 schemaVersion 1 manifest 和明确的文件清单；工具逐个校验 SHA-256，只复制列出的原生文件，拒绝数据库路径、目录逃逸、重复路径和已有目标。产物布局为 `clientVersion/platform/arch/manifestSha256/`，文件 URL 使用相对路径；manifest 最后写入。摘要同时标识文件集合和版本配置变化，无需覆盖已有版本。失败复制目录没有 manifest，需确认失败原因后清理该目录再重试。

将产物目录通过 HTTPS 静态存储托管后，使用完整 manifest URL 和工具输出的 manifestSha256 调用 createClient。摘要应通过可信渠道分发。工具只准备本地目录，不上传文件、不建立公共镜像，也不把二进制库存升级为平台运行支持声明。不同发行来源应分别保留来源证明，不能仅凭目录版本名称判断原生签名完整性。

### 实际包交付证据

2026-09-30 将已导出的 macOS arm64 QQ 7.0.2-53644 清单实际整理到本地镜像：1156 个文件，规范化 manifest SHA-256 为 `a63e1cafcbfeabf673524aaae4326225b4d0e777e32a8005e2b2efe747300f9d`。运行 `node scripts/verify-mirror-delivery.ts STAGED_PACKAGE_DIR`，通过 localhost 服务调用 SDK 原生包解析器，首次 1157 次请求（manifest 加全部文件），再次 1 次请求（仅 manifest），证明文件交付与校验缓存复用。暂存缓存验证后删除，源文件保留。回执在 `.local/mirror-delivery-verification.json`。没有加载 wrapper 或使用账号，此验证不证明签名、安全性、Linux 支持或公共镜像可用性。

镜像模式的版本配置与可信 manifest 绑定：若调用方同时传入 version，它必须逐项匹配 clientVersion、appId、qua，否则在下载原生文件前拒绝。不能用一个镜像包覆盖成另一版本的登录参数。本地 wrapperPath 模式仍要求调用者提供与其实际二进制相符的版本配置；没有 manifest 时 SDK 无法仅靠这些字符串证明二进制来源或版本。

2026-09-30 已将静态导出的 Linux 3.2.32-52194 两个架构包实际加入本地镜像目录：arm64 8 个文件，manifest SHA-256 `b9b188fd0bd0eecacf148744cd8093587d50fc3cbef114375bf503e9228b07c9`；x64 7 个文件，manifest SHA-256 `a371eee7fd71c860dd9e15da7ab34ee8f2f7e428d175548172be8b399483e8da`。目录按版本/platform/arch/摘要组织，未上传公共存储。此产物经过文件哈希与静态 ELF 依赖闭包检查，随后两个架构均在断网临时容器中以 Node 24.20.0 实际加载成功、枚举 98 个导出并正常退出；仅证明独立包加载，不含登录或签名环境验收。系统依赖仍需按各自 dependency-report.json 准备。

## 已实际入库的第二个 Linux 版本

3.2.31-51102 arm64 已通过现有 stageMirror 工具验证并复制八个原生依赖文件，目录为 `3.2.31-51102/linux/arm64/54417e9eb562be557a7d2eb405e3dc0f2d9017ae5a83655bd5729651aa4d5bce/`。3.2.32 的目录保持独立，没有覆盖或更改。导出 manifest 摘要与镜像 manifest 摘要不同，是因为 stageMirror 按 schema v1 排序、规范化 URL 并去掉非下载字段；原生文件摘要仍逐个校验。这不是原生二进制修改。

当前 npm 包从这个镜像目录完成可信摘要校验、本地 HTTP 下载、普通 Node 初始化和关闭，92 个导出；全程断网、空账号目录。回执为 `.local/research/linux-3.2.31-mirror.json` 和 `linux-3.2.31-staged-consumer.json`。这证明精确版本共存及消费路径；尚未实现可变 catalog 自动选择，也不代表签名真实性或账号能力验收通过。

## 四个 Linux 精确身份的镜像核对

3.2.31-51102 x64 也已入不可变目录：`3.2.31-51102/linux/x64/3cc07b3000fb45df0912123c0e97c18f18d1dc1b638cc236656cd93d741d49ec/`，七个文件。当前 npm 包从该目录下载、初始化、编码、关闭通过，92 个导出，断网且无账号；amd64 模拟执行。回执 `.local/research/linux-3.2.31-x64-staged-consumer.json`。

四个 Linux 包的目录身份、manifest 内容及全部原生文件 SHA-256 已重新核对，回执 `.local/research/linux-mirror-matrix.json`。从各自 major.node 提取的 AppID 分别为：3.2.31 arm64 `537376498`、x64 `537376497`；3.2.32 arm64 `537379448`、x64 `537379447`。因此同版本不同架构也不能共用 AppID 配置。这个核对只证明包身份及完整性，不证明账号登录或协议签名。

## 2026-10-09 原生 runner 多版本实证

[CI 37888770685](https://github.com/lc-cn/qq-native-mirror/actions/runs/37888770685) 在四个独立原生 Linux runner 上实际验收，不依赖本机 Docker 或 amd64 模拟。全部使用官方 Node 24.20.0 和已校验的修正主包候选（源 run 37886708952、主包 SHA-256 `0e51e6dee2a99503c8bd0849483394e5979961b01d29826cdcfd08302affd556`）。安装时省略所有原生辅包，确认它们均未安装，消费者按包名导入主包，从公共默认 `catalog.json` 下载原生文件。

| 精确内核     | 架构  | 选择方式                     | 导出数 | 校验原生文件数 | 再次初始化的原生文件请求数 |
| ------------ | ----- | ---------------------------- | -----: | -------------: | -------------------------: |
| 3.2.31-51102 | x64   | 完整 version 配置指定旧版    |     92 |              7 |                          0 |
| 3.2.31-51102 | arm64 | 完整 version 配置指定旧版    |     92 |              8 |                          0 |
| 3.2.32-52194 | x64   | 不传 version，自动选当前最新 |     98 |              7 |                          0 |
| 3.2.32-52194 | arm64 | 不传 version，自动选当前最新 |     98 |              8 |                          0 |

每次均使用新缓存和空账号目录，禁用符号链接创建，逐文件独立复核 SHA-256，并完成两次普通 Node 初始化和关闭。第二次初始化在发出任何原生载荷请求前就会拒绝测试，四项均没有触发该拒绝。重定向请求计入首次原生载荷请求数，因此请求数不能当作文件数。

该实证覆盖多个内核在现有通用下载、加载和生命周期逻辑中的消费，不证明旧版账号登录、签名真实性或业务方法参数兼容。当前好友查询 driver 仍明确拒绝未经契约验证的 3.2.31 版本；不要把初始化通过当作完整客户端支持。其他三类平台的当前版本已通过独立六平台初始化 CI 37886708952，但它也没有执行账号操作。

## 六平台公共默认目录实证（2026-10-09）

[CI 37890258044](https://github.com/lc-cn/qq-native-mirror/actions/runs/37890258044) 的六个原生 Windows/Linux/macOS x64/arm64 runner 全部通过。消费者安装同一修正主包候选，并省略全部原生辅包；按包名导入后，`createClient` 不传 `wrapperPath`、`version`、`manifestUrl` 或 `catalogUrl`，实际从公共默认目录自动选择当前设备的最新版本。配置了 `https://gh-proxy.com/` 加速和源站回退，因此它不代表纯源站直连的网络表现。

默认目录保留原来的五条完整包记录，并加入已通过公共冷下载的 macOS x64、Windows x64/arm64 压缩记录，覆盖六种设备组合。每个 runner 都验证固定主包字节、设备对应 manifest 摘要、每个运行文件摘要、初始化/关闭以及第二次零原生文件下载；符号链接创建被禁用。Linux 两种架构均自动选中较新的 3.2.32-52194。该验收没有登录、恢复或账号业务操作，也不证明 npm 官方安装路径或签名真实性。

## 2026-10-10 当前源码与 Linux 两版本实证

[CI 37998959637](https://github.com/lc-cn/qq-native-mirror/actions/runs/37998959637) 使用源码 `075b6d0437f068b5d75d6671101b56a27b2bc5fe`，四个独立原生 Linux runner、Node 24.20.0，通过包名导入本轮源码实际打出的主包。安装省略平台辅包，走公共 catalog 镜像解析；旧版指定精确版本，新版使用自动最新选择。四项均完成原生初始化、冷缓存下载、暖缓存复用和关闭，无账号、无登录。

| 内核         | CPU   | 导出数 | 校验文件数 | 首轮原生请求次数 | 第二轮原生请求次数 |
| ------------ | ----- | ------ | ---------- | ---------------- | ------------------ |
| 3.2.31-51102 | x64   | 92     | 7          | 14               | 0                  |
| 3.2.31-51102 | arm64 | 92     | 8          | 16               | 0                  |
| 3.2.32-52194 | x64   | 98     | 19         | 38               | 0                  |
| 3.2.32-52194 | arm64 | 98     | 20         | 40               | 0                  |

首轮请求次数统计下载尝试，不等于唯一文件数量。实际下载并核对四份 CI ZIP、主包 SHA-256/SHA-512、运行回执及当前 manifest；主包内 72 份 JavaScript 模块和 8 份公开声明均与冻结的本地构建逐字节一致。证据见 [current-linux-versions-ci-37998959637.json](evidence/current-linux-versions-ci-37998959637.json)。

旧内核 `3.2.31` 的 `listFriends` 版本门禁继续保留，原生包也未声明自带视频 codec。初始化通过不能据此宣称其好友、媒体、登录、签名或其他业务能力通过；本轮没有修改默认版本，也没有 npm 发布。
