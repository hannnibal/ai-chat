# Baileys-Adapter Windows 部署方案

> 适用场景：在非洲当地一台 Windows 电脑上长期运行 `baileys-adapter`
> 目标：你通过远程方式登录这台电脑，完成安装、部署、启动和后续维护
> 数据存储：本地文件持久化，不使用 PostgreSQL

---

## 总体建议

- 推荐系统：`Windows 10/11 Pro`
- 推荐远程方案：`Tailscale + Windows 远程桌面 / SSH`
- 推荐运行方式：`PM2 + pm2-windows-startup`
- 推荐目录：`C:\baileys-adapter`
- 推荐数据目录：`C:\baileys-adapter\wa_data`

说明：

- 这台电脑应尽量固定供电、固定网络、关闭睡眠
- 不建议直接用临时 `trycloudflare.com` 地址做正式回调
- 不建议使用 `npm run dev` 长期挂服务

---

## 最简单的方式：直接使用 `deploy.ps1`

如果你不熟悉 Windows，建议优先用一键脚本：

- 脚本路径：[scripts/windows/deploy.ps1](/Users/hannibal/chatwoot/baileys-adapter/scripts/windows/deploy.ps1)
- 作用：自动安装依赖、拉代码、生成 `.env`、安装项目依赖、构建、交给 PM2 托管

脚本会自动做这些事：

- 检查并安装 `Git`
- 检查并安装 `Node.js`
- 安装 `PM2`
- 安装 `pm2-windows-startup`
- 克隆或更新你的 GitHub 仓库
- 生成 `C:\baileys-adapter\.env`
- 执行 `npm install`
- 执行 `npm run build`
- 启动 `baileys-adapter`

建议：

- 第一次运行时，用“管理员 PowerShell”
- 仓库如果是公开的，不需要输入 GitHub 密码
- 运行脚本前，先准备好这 3 个值：
  - `CHATWOOT_BASE_URL`
  - `CHATWOOT_API_TOKEN`
  - `CHATWOOT_ACCOUNT_ID`

---

## 一键脚本详细使用说明

下面这部分按“你远程进入一台 Windows 电脑，然后一步一步操作”来写。

### 入口 1：先下载整个项目，再运行脚本

这是最推荐的方式，最直观。

#### 1. 打开浏览器

在 Windows 电脑桌面上：

- 点击左下角 `开始`
- 找到 `Microsoft Edge` 或 `Google Chrome`
- 打开浏览器

#### 2. 打开 GitHub 仓库

在浏览器地址栏输入：

```text
https://github.com/hannnibal/ai-chat
```

按回车。

#### 3. 下载 ZIP 压缩包

在 GitHub 页面右上区域：

- 点击绿色按钮 `Code`
- 在弹出的菜单里点击 `Download ZIP`

浏览器会开始下载一个压缩包，通常会保存在：

```text
C:\Users\你的用户名\Downloads
```

#### 4. 解压 ZIP 压缩包

下载完成后：

- 打开 `文件资源管理器`
- 点击左侧 `下载`
- 找到刚下载的 ZIP 文件，例如 `ai-chat-main.zip`
- 右键这个文件
- 点击 `全部提取...`
- 目标位置建议选择：

```text
C:\Users\你的用户名\Desktop\ai-chat-main
```

- 点击 `提取`

#### 5. 找到脚本文件

解压后进入这个目录：

```text
ai-chat-main\scripts\windows\
```

你会看到：

```text
deploy.ps1
```

#### 6. 以管理员身份打开 PowerShell

在 Windows 左下角：

- 点击 `开始`
- 输入 `PowerShell`
- 在搜索结果里找到 `Windows PowerShell`
- 右键它
- 点击 `以管理员身份运行`

如果弹出系统确认框：

- 点击 `是`

#### 7. 切换到脚本所在目录

假设你刚才把 ZIP 解压到了桌面，那么在 PowerShell 输入：

```powershell
cd C:\Users\你的用户名\Desktop\ai-chat-main\scripts\windows
```

如果你不确定你的用户名是什么，可以先打开 `文件资源管理器` 看地址栏路径，再照着输入。

#### 8. 运行脚本

在 PowerShell 输入：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

然后按回车。

脚本运行时会自动：

- 安装 Git
- 安装 Node.js
- 安装 PM2
- 从 GitHub 拉代码到 `C:\baileys-adapter`
- 询问并写入 Chatwoot 配置
- 构建并启动服务

#### 9. 按提示输入 Chatwoot 配置

脚本会停下来，依次问你：

```text
CHATWOOT_BASE_URL
CHATWOOT_API_TOKEN
CHATWOOT_ACCOUNT_ID
```

你就把真实值粘贴进去，每输完一个按一次回车。

例如：

```text
CHATWOOT_BASE_URL: https://app.chatwoot.com
CHATWOOT_API_TOKEN: xxxxxxxxx
CHATWOOT_ACCOUNT_ID: 158759
```

#### 10. 等脚本执行完

正常结束后，会看到类似信息：

```text
Health URL:  http://localhost:3001/health
Admin URL:   http://localhost:3001/admin
```

这说明部署成功了。

---

### 入口 2：如果你已经把项目克隆到 `C:\baileys-adapter`

如果代码已经在 Windows 电脑上了，可以直接运行仓库里的脚本。

#### 1. 打开项目目录

在 `文件资源管理器` 进入：

```text
C:\baileys-adapter
```

#### 2. 找到脚本目录

继续进入：

```text
scripts\windows
```

#### 3. 在当前文件夹打开 PowerShell

有几种最简单的方法：

- 方法 A：
  - 在文件夹空白处按住 `Shift`
  - 右键
  - 点击 `在此处打开 PowerShell 窗口`
  - 如果你的系统显示的是 `在终端中打开`，点它也可以

- 方法 B：
  - 点击文件资源管理器顶部地址栏
  - 输入：

```text
powershell
```

  - 按回车

#### 4. 运行脚本

输入：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

如果你希望脚本运行时不要再询问，而是直接带参数执行，可以这样：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 `
  -ChatwootBaseUrl "https://app.chatwoot.com" `
  -ChatwootApiToken "你的token" `
  -ChatwootAccountId "158759" `
  -ForceEnvUpdate
```

说明：

- 反引号 `` ` `` 是 PowerShell 的换行符
- 如果你怕输错，也可以全部写成一行

一行版本如下：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -ChatwootBaseUrl "https://app.chatwoot.com" -ChatwootApiToken "你的token" -ChatwootAccountId "158759" -ForceEnvUpdate
```

---

## 脚本运行时你会看到什么

脚本会按顺序打印：

- `Starting Windows deployment`
- `Installing Git`
- `Installing Node.js`
- `Installing PM2`
- `Preparing directories`
- `Cloning repository`
- `Writing .env`
- `Installing project dependencies`
- `Configuring PM2`
- `Deployment finished`

如果某一步卡住，通常是在：

- `winget` 正在安装软件
- `npm install` 正在下载依赖
- 网络比较慢

第一次部署时，等待几分钟是正常的。

---

## 部署完成后如何验证

### 1. 打开健康检查地址

在浏览器打开：

```text
http://localhost:3001/health
```

如果看到 JSON，说明服务已经启动。

### 2. 打开管理后台

在浏览器打开：

```text
http://localhost:3001/admin
```

### 3. 第一次使用后台的顺序

在 `/admin` 页面里：

1. 点击 `Add Account`
2. 输入账号标签，例如 `xiaosong`
3. 填写这个账号对应的 `Chatwoot Inbox ID`
4. 保存
5. 点击 `Scan QR`
6. 用该 WhatsApp 手机扫码

---

## 如果脚本提示报错，最常见的处理方式

### 1. 提示 `winget is not available`

说明这台 Windows 没装 `App Installer`。

处理方法：

- 打开 `Microsoft Store`
- 搜索 `App Installer`
- 安装
- 重新打开 PowerShell
- 再运行脚本

### 2. 提示 `node is still not in PATH`

说明 Node.js 刚装好，但当前 PowerShell 还没刷新环境变量。

处理方法：

- 关闭当前 PowerShell
- 重新用管理员方式打开 PowerShell
- 再运行一次脚本

### 3. 提示 `.env already exists`

说明之前已经部署过。

如果你想覆盖 `.env`，使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -ForceEnvUpdate
```

### 4. 提示仓库目录非空

说明：

- `C:\baileys-adapter` 已存在
- 但不是 Git 仓库

处理方法二选一：

- 手动清空 `C:\baileys-adapter`
- 或运行脚本时改目录：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -InstallDir "C:\baileys-adapter-2"
```

---

## 第 1 步：先做机器基础设置

### 1.1 关闭睡眠和自动休眠

在 Windows 设置中关闭：

- 屏幕关闭可按需设置
- 睡眠：`从不`
- 休眠：`从不`

或者用管理员 PowerShell：

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /hibernate off
```

### 1.2 设置开机自动登录或保证有人能登录桌面

因为 WhatsApp 配对、维护和部分系统任务会更方便通过桌面处理，建议这台机器保持可登录状态。

### 1.3 使用固定内网 IP

在路由器里给这台电脑绑定固定 DHCP 地址，避免 IP 变化影响远程维护。

---

## 第 2 步：安装远程管理工具

强烈建议先安装 `Tailscale`，这样你不用直接暴露公网端口。

### 2.1 安装 Tailscale

访问：

`https://tailscale.com/download`

下载安装 Windows 版本并登录你的账号。

安装后记下这台机器的 Tailscale 地址，例如：

```text
100.x.x.x
```

### 2.2 可选：启用 OpenSSH Server

用管理员 PowerShell 执行：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

然后你就可以通过：

```bash
ssh username@100.x.x.x
```

远程登录。

如果你更习惯桌面操作，也可以直接用 Windows 远程桌面连接 Tailscale IP。

---

## 第 3 步：安装基础环境

建议安装：

- Git
- Node.js 20 LTS
- PM2
- pm2-windows-startup
- Caddy 或 Cloudflared（二选一，用于暴露 HTTPS 域名，可后续再装）

### 3.1 安装 Git

下载并安装：

`https://git-scm.com/download/win`

安装完成后打开 PowerShell 验证：

```powershell
git --version
```

### 3.2 安装 Node.js 20 LTS

下载并安装：

`https://nodejs.org/`

安装完成后验证：

```powershell
node --version
npm --version
```

### 3.3 安装 PM2

```powershell
npm install -g pm2 pm2-windows-startup
```

验证：

```powershell
pm2 --version
```

---

## 第 4 步：创建部署目录

建议目录：

```powershell
mkdir C:\baileys-adapter
mkdir C:\baileys-adapter\wa_data
```

最终目录结构建议如下：

```text
C:\baileys-adapter
  ├─ dist
  ├─ src
  ├─ package.json
  ├─ package-lock.json
  ├─ .env
  └─ wa_data
      ├─ accounts.json
      ├─ conversation-mappings.json
      └─ wa_session_*
```

---

## 第 5 步：同步代码到 Windows 电脑

你可以选两种方式。

如果你想直接一键部署，也可以在拉下代码后执行：

```powershell
cd C:\baileys-adapter
powershell -ExecutionPolicy Bypass -File .\scripts\windows\deploy.ps1
```

脚本会自动处理：

- 安装 Git / Node.js（缺失时）
- 安装 PM2 / pm2-windows-startup
- 同步 GitHub 代码
- 生成 `.env`
- `npm install`
- `npm run build`
- 启动 PM2

### 方式 A：Git 拉代码

如果仓库在 GitHub / GitLab：

```powershell
cd C:\
git clone <你的仓库地址> baileys-adapter
cd C:\baileys-adapter
npm install
npm run build
```

如果仓库根目录不是 `baileys-adapter`，按你的实际路径调整。

### 方式 B：本地打包上传

在你的 Mac 上执行：

```bash
cd ~/chatwoot/baileys-adapter
npm run build
tar czf baileys-adapter-windows.tar.gz \
  package.json package-lock.json tsconfig.json \
  dist/ src/
```

然后把压缩包传到 Windows 电脑，可以通过：

- Tailscale 文件传输
- WinSCP
- SCP
- 远程桌面复制

上传后在 Windows PowerShell 解压：

```powershell
cd C:\
mkdir baileys-adapter
tar -xzf .\baileys-adapter-windows.tar.gz -C C:\baileys-adapter
cd C:\baileys-adapter
npm install --production
```

说明：

- 不要把本地 `.env` 直接打包上传
- Windows 机器上的 `.env` 请单独创建

---

## 第 6 步：创建生产环境变量

在 `C:\baileys-adapter` 下创建 `.env`：

```env
PORT=3001
NODE_ENV=production

CHATWOOT_BASE_URL=https://app.chatwoot.com
CHATWOOT_API_TOKEN=你的token
CHATWOOT_ACCOUNT_ID=158759

AI_MIDDLEWARE_URL=
AI_MIDDLEWARE_TOKEN=

WA_SESSION_DIR=C:\baileys-adapter\wa_data\wa_session
```

说明：

- 不再需要 `CHATWOOT_INBOX_ID`
- 每个账号的 Inbox ID 在 `/admin` 页面单独维护
- `WA_SESSION_DIR` 建议用固定绝对路径

---

## 第 7 步：安装依赖并构建

```powershell
cd C:\baileys-adapter
npm install
npm run build
```

验证：

```powershell
node .\dist\index.js
```

如果看到类似输出，说明服务能启动：

```text
Baileys Adapter HTTP server started
Account manager initialized
```

先按 `Ctrl+C` 停掉，准备交给 PM2 托管。

---

## 第 8 步：用 PM2 启动

```powershell
cd C:\baileys-adapter
pm2 start .\dist\index.js --name baileys-adapter --max-memory-restart 512M
pm2 save
```

查看状态：

```powershell
pm2 status
pm2 logs baileys-adapter --lines 50
```

说明：

- 生产环境不要使用 `npm run dev`
- `512M` 是比较稳妥的阈值

---

## 第 9 步：设置 Windows 开机自动启动 PM2

以管理员 PowerShell 执行：

```powershell
pm2-startup install
pm2 save
```

然后重启 Windows 验证：

```powershell
pm2 status
```

如果你的环境里 `pm2-startup install` 没成功，可以改用“任务计划程序”兜底：

### 任务计划程序备用方案

创建一个开机任务，执行：

```text
程序: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
参数: -Command "cd C:\baileys-adapter; pm2 resurrect"
```

---

## 第 10 步：本地访问验证

在 Windows 本机浏览器打开：

```text
http://localhost:3001/health
http://localhost:3001/admin
```

如果你通过 Tailscale 访问，也可以试：

```text
http://100.x.x.x:3001/health
http://100.x.x.x:3001/admin
```

注意：

- 如果你打算直接通过 Tailscale 内网管理，可以先不做公网域名
- 但 Chatwoot Webhook 一般还是需要稳定的公网 HTTPS 地址

---

## 第 11 步：给服务提供稳定 HTTPS 地址

你有两种推荐方式。

### 方案 A：Cloudflare Tunnel

适合：

- 没有固定公网 IP
- 不想折腾端口映射
- 想快速拿到 HTTPS 地址

流程：

1. 安装 `cloudflared`
2. 登录 Cloudflare
3. 给 `http://localhost:3001` 建一个 Tunnel
4. 绑定到你自己的正式域名，比如：

```text
wa.example.com
```

优点：

- 不用暴露家宽 / 本地公网端口
- HTTPS 比较方便

缺点：

- 依赖 Cloudflare Tunnel 进程

### 方案 B：Caddy + 路由器端口映射 + DDNS / 固定 IP

适合：

- 你能控制当地网络设备
- 电脑所在网络支持端口映射
- 你有域名和 DDNS

流程：

1. 路由器映射 `80/443` 到这台电脑
2. 安装 Caddy
3. 用 Caddy 给 `localhost:3001` 反代并自动签证书

优点：

- 独立性更高

缺点：

- 本地网络配置复杂一点

---

## 第 12 步：Chatwoot 配置

部署完成后，把 Chatwoot 相关回调改成你的正式 HTTPS 地址。

例如：

```text
https://wa.你的域名.com/api/v1/webhooks/chatwoot/outbound
```

同时你自己的管理入口将是：

```text
https://wa.你的域名.com/admin
```

---

## 第 13 步：首次上线后的操作顺序

1. 远程登录 Windows 电脑
2. 启动 `baileys-adapter`
3. 打开 `/admin`
4. 创建账号
5. 为该账号填写对应的 `Chatwoot Inbox ID`
6. 点击 `Scan QR` 完成授权
7. 在 Chatwoot 中测试发消息
8. 检查：
   - 入站消息是否进入正确 inbox
   - 出站消息是否能回到 WhatsApp
   - 会话是否稳定复用

---

## 第 14 步：日常运维命令

```powershell
cd C:\baileys-adapter

pm2 status
pm2 logs baileys-adapter --lines 100
pm2 restart baileys-adapter
pm2 stop baileys-adapter
pm2 delete baileys-adapter
pm2 resurrect
```

如果你更新代码：

```powershell
cd C:\baileys-adapter
git pull
npm install
npm run build
pm2 restart baileys-adapter
```

---

## 第 15 步：必须做的安全与稳定设置

### 安全

- 使用 Tailscale，不要直接把管理页裸露到公网
- 如果提供公网域名，务必给 `/admin` 和 `/api/v1/whatsapp/` 加认证
- 不要把 `.env` 发给当地使用者
- 给 Windows 登录账号设置强密码

### 稳定性

- 关闭自动睡眠
- 尽量不要让普通用户使用这台电脑做日常办公
- 避免自动系统更新在白天重启
- 给 `C:\baileys-adapter\wa_data` 做定期备份

推荐至少备份：

```text
C:\baileys-adapter\.env
C:\baileys-adapter\wa_data\
```

---

## 常见问题

### 1. 电脑重启后账号还在吗？

在 `wa_data` 没丢的前提下，session 会保留。  
服务启动后可以通过 `Reconnect` 复用之前已授权的账号。

### 2. 为什么不建议用 `npm run dev`？

因为它适合开发调试，不适合长期稳定运行。  
生产环境请使用：

```powershell
pm2 start .\dist\index.js --name baileys-adapter
```

### 3. Windows 上一定要装数据库吗？

不需要。  
你现在这套方案就是本地文件持久化，足够先跑起来。

### 4. 如果后来想迁移到云服务器呢？

直接备份并迁移以下内容即可：

```text
wa_data\
.env
代码目录
```
