# Baileys-Adapter 部署方案

> 目标服务器：AWS EC2 (Debian 12, 2核, 7.7GB RAM, 20GB SSD, 欧洲区域)
> 部署内容：baileys-adapter（Chatwoot 继续使用托管版 app.chatwoot.com）

---

## 服务器现状

| 项目 | 值 |
|------|-----|
| OS | Debian 12 (bookworm) |
| CPU | 2 核 |
| 内存 | 7.7GB（已用 5.6GB，可用 ~2.1GB） |
| 磁盘 | 20GB（已用 3.8GB，剩余 15GB） |
| 已有服务 | 3 个 Java 应用（~5.4GB）+ Nginx |
| 缺少 | Node.js、Git |

---

## 第 1 步：添加 Swap（防止 OOM）

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 降低 swappiness，避免系统过早把活跃内存换到磁盘
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swappiness.conf
sudo sysctl --system

# 验证
free -h
```

## 第 2 步：安装基础依赖 + Node.js 20

```bash
# 安装基础依赖
sudo apt update
sudo apt install -y git curl ca-certificates

# 安装 Node.js 20 (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node --version   # 应显示 v20.x
npm --version
git --version
```

## 第 3 步：安装 PM2（进程管理器）

```bash
sudo npm install -g pm2
```

## 第 4 步：上传代码到服务器

### 方式 A：Git 推送（推荐）

如果代码在 GitHub/GitLab：

```bash
sudo mkdir -p /opt/baileys-adapter
sudo chown admin:admin /opt/baileys-adapter
cd /opt
git clone <你的仓库地址> baileys-adapter
cd baileys-adapter
npm install
npm run build
```

### 方式 B：本地打包上传

在 Mac 本地执行：

```bash
cd ~/chatwoot/baileys-adapter
npm run build
tar czf baileys-adapter.tar.gz \
  package.json package-lock.json tsconfig.json \
  dist/ src/
scp -i ~/.ssh/your-key.pem baileys-adapter.tar.gz admin@<服务器IP>:/tmp/
```

服务器上执行：

```bash
sudo mkdir -p /opt/baileys-adapter
sudo chown admin:admin /opt/baileys-adapter
cd /opt/baileys-adapter
tar xzf /tmp/baileys-adapter.tar.gz
npm install --production
```

说明：

- 不要把本地 `.env` 一起打包上传
- 生产环境的 `.env` 请在服务器上单独创建和维护

## 第 5 步：配置环境变量

```bash
cd /opt/baileys-adapter
nano .env
```

写入（根据实际值修改）：

```env
PORT=3001
NODE_ENV=production

CHATWOOT_BASE_URL=https://app.chatwoot.com
CHATWOOT_API_TOKEN=你的token
CHATWOOT_ACCOUNT_ID=158759

AI_MIDDLEWARE_URL=
AI_MIDDLEWARE_TOKEN=

WA_SESSION_DIR=/opt/baileys-adapter/wa_data/wa_session
```

创建数据目录：

```bash
mkdir -p /opt/baileys-adapter/wa_data
```

说明：

- `CHATWOOT_INBOX_ID` 已移除
- 多账号模式下，请在管理页面里为每个 WhatsApp 账号分别填写对应的 `Chatwoot Inbox ID`

## 第 6 步：用 PM2 启动并设置开机自启

```bash
cd /opt/baileys-adapter

# 启动
pm2 start dist/index.js --name baileys-adapter --max-memory-restart 512M

# 查看日志
pm2 logs baileys-adapter --lines 20

# 保存 + 开机自启
pm2 save
which pm2
# 按上面输出的实际路径执行；如果是 /usr/local/bin/pm2，则把 /usr/local/bin 加进 PATH
sudo env PATH=$PATH:/usr/bin:/usr/local/bin pm2 startup systemd -u admin --hp /home/admin
```

说明：

- 生产环境只运行编译后的 `dist/index.js`
- 不要使用 `npm run dev`
- `512M` 是更稳妥的 PM2 重启阈值，`200M` 太容易误触发重启

### PM2 常用命令

```bash
pm2 status                    # 查看状态
pm2 logs baileys-adapter      # 查看日志
pm2 restart baileys-adapter   # 重启
pm2 stop baileys-adapter      # 停止
```

## 第 7 步：Nginx 反向代理 + SSL

### 7a. GoDaddy DNS 配置

登录 GoDaddy → 域名 → DNS Management，添加 A 记录：

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | wa | 服务器公网 IP | 600 |

### 7b. 给管理页加 Basic Auth（强烈建议）

安装工具并创建密码文件：

```bash
sudo apt install -y apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd admin
```

说明：

- 这里的 `admin` 是登录用户名，可自行替换
- 命令会提示你输入管理页密码

### 7c. Nginx 配置

```bash
sudo nano /etc/nginx/sites-available/baileys-adapter
```

写入：

```nginx
server {
    listen 80;
    server_name wa.你的域名.com;

    location /admin {
        auth_basic "Restricted";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/v1/whatsapp/ {
        auth_basic "Restricted";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;  # SSE 长连接需要
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/baileys-adapter /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

说明：

- `/admin` 和 `/api/v1/whatsapp/` 会要求输入用户名密码
- `/api/v1/webhooks/...` 不要加 Basic Auth，否则 Chatwoot Webhook 会失败
- SSE 事件流 `/api/v1/whatsapp/events` 已包含在 `/api/v1/whatsapp/` 下面，也会受到保护

### 7d. SSL 证书（Let's Encrypt）

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d wa.你的域名.com
```

### 7e. AWS 安全组

确保 EC2 安全组放行端口：
- **80** (HTTP) — certbot 验证需要
- **443** (HTTPS) — 正式访问

---

## 完成后验证

```bash
# 服务状态
pm2 status
pm2 logs baileys-adapter --lines 50

# 本地测试
curl http://localhost:3001/health

# 外网测试（DNS 生效后）
curl https://wa.你的域名.com/health

# 管理页面
# 浏览器打开 https://wa.你的域名.com/admin
```

## Chatwoot Webhook 更新

部署完成后，Chatwoot Inbox 设置中把 Webhook URL 改为：

```
https://wa.你的域名.com/api/v1/webhooks/chatwoot/outbound
```

---

## 安全加固（上线后处理）

1. **已完成第一层保护** — `/admin` 与 `/api/v1/whatsapp/` 已通过 Nginx Basic Auth 保护
2. **后续可升级** — 应用层再给 `/api/v1/whatsapp/` 加 token 认证
3. **防火墙** — 端口 3001 仅本地 Nginx 访问，不对外开放
4. **数据目录备份** — 至少定期备份 `/opt/baileys-adapter/wa_data/`
5. **注意文件持久化** — 当前账号配置、session、conversation mappings 都保存在本地文件中
