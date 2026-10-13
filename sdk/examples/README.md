# 本地登录和关键词回复示例

`keyword-reply.ts` 只展示创建客户端、订阅事件、用 `message.reply(text, true)`
引用回复、登录和关闭；SDK 自动使用原群聊或私聊会话。
`support/` 分别处理配置与账号标记、二维码、回复过滤和退出管理。
`demo.ts` 是处理加载卡住时强制退出的父进程入口。

在当前源码中运行，使用本项目的 SDK，不需要安装 QQ、Electron 或 Docker。
Node 要求与 SDK 一致：macOS/Linux 为 Node 24+；当前 Windows 原生包要求官方
Node 24.20.0 及匹配配置。Linux 需要 glibc 与 libgnutls.so.30；没有桌面图片查看器时
将 openQr 设为 false，手动打开终端打印的 PNG 路径。

```sh
cd /Users/liuchunlang/qq-bot/repository/sdk
npm ci --ignore-scripts --omit=optional
npm run demo
```

`npm run demo` 先编译 SDK，然后启动示例。未传 wrapperPath/version 时按设备解析
镜像最新版本，复用校验后的缓存或下载缺失资源。下载失败会报错；不会偷偷换成
其他版本。示例不会打印原生日志、二维码 URL、消息正文或原始回调。

1. 首次加载资源可能需要等待下载，终端会显示加载阶段与账号目录。
2. 首次运行二维码生成后默认打开系统图片查看器，也打印 PNG 文件路径。用手机 QQ 扫描并确认。
   上线后保存账号标记；再次运行同一命令默认恢复该账号，不再请求二维码。
3. 认证完成后继续等待 Session 就绪，终端显示“已上线”才启用回复。
4. 读取好友和群列表并打印数量；读取失败单独报告，不用空列表伪装成功。
5. 用另一个 QQ 私聊本账号，或者在本账号所在群发送 `ping`，示例引用该消息回复 `pong`，
   并附带示例进程当前 RSS 内存量（MB，不包含 SDK 原生工作进程）。
6. 按 Ctrl+C 退出。正常先等待 client.close；加载卡住时 5 秒终止子进程、7 秒强制结束。
   强制结束是兜底，不等价于原生优雅关闭。SIGINT 退出码为 130。

默认同时启用全部群聊和私聊的精确关键词匹配。只匹配 text 元素拼接后的完整
`ping`（去掉两端空白），不回复自己的消息；相同消息最多处理一次，每个会话
3 秒内最多回复一次。只处理本轮上线附近的新消息，兼容秒和毫秒时间戳。
去重及限流记录最多各保留 1000 项。发送失败不重试，不撤回，也不自动处理好友或群申请。

## 自定义配置

```sh
mkdir -p .local
cp examples/config.example.json .local/demo.json
npm run demo -- --config .local/demo.json
```

需要换账号或重新扫码时运行 `npm run demo -- --qr`；使用配置时可加
`--config .local/demo.json --qr`。恢复失败会退出，不自动请求新二维码。

如果已经用旧示例扫码、账号目录中还没有 `demo-session.json`，可在上述配置里
加上 `"login": { "method": "restore" }`，使用原账号目录启动一次。SDK 会选择
唯一可恢复账号；恢复上线后生成标记，之后可移除这项配置。无需重新扫码。

配置中的本地路径相对于配置文件所在目录；不传配置时，账号与原生缓存分别在
SDK 的 `.local/demo-account` 与 `.local/demo-native-cache`。这些目录不进入 Git。
`userIds`/`groupIds` 留空代表所有会话；填写字符串 ID 可以缩小回复范围。
例如只测试 QQ 8596238，可设置 `userIds: ["8596238"]`、`groupMessages: false`。

- `keyword`、`reply`：自定义关键词和回复文字。
- `openQr: false`：仅保存二维码，不自动打开图片查看器。
- `loadContacts: false`：跳过好友、群列表预加载，仍监听消息。
- `client.wrapperPath`：使用已有完整原生资源目录内的 wrapper.node；通常从相邻
  manifest.json 获取版本与 codec。路径可为绝对路径。不要只复制一个 wrapper 文件。
- `client.version`：可选，格式见 SDK ClientOptions；省略时自动选择。
- `client.downloadMirrors`：可选加速前缀，原始下载地址仍作最后回退。
- `login`：省略时根据本账号目录的 `demo-session.json` 选择首次扫码或恢复指定账号。
  显式 `{ "method": "qr" }` 会每次扫码；也可指定
  `{ "method": "restore", "uin": "你的QQ号" }`。恢复失败直接退出，不自动再发二维码。

保持 client.autoReconnect 为 false；示例不会在掉线或踢下线后反复登录。
按 Ctrl+C 后保留账号授权文件和已校验的原生缓存，只删除本轮二维码图片。
默认请求原生 `rememberPassword: true`；是否存在可恢复授权仍由原生登录记录决定。
`demo-session.json` 仅保存账号号码，不是 token，也不能独立恢复登录；迁移时必须
保留完整账号目录。标记采用临时文件加原子替换写入，在 POSIX 系统以 0600 权限保存。

本示例的模拟测试证明流程、消息路由和退出逻辑；实际登录、消息可达性需要你
运行后验证。原生签名真实性仍未排除，已有登录结果不能证明长期运行安全。
