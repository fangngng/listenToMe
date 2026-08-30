# ListenToMe 部署文档（Ubuntu 20.04）

> 单机部署：Node.js + systemd 常驻 + Nginx 反代 + HTTPS。
> 全程约 15 分钟；只有一台内网机器、没有域名时，看第 7 节的简化方案。

## 0. 前提

- 一台 Ubuntu 20.04 服务器（云主机或内网机器），有 sudo 权限
- 两个 API Key：硅基流动（ASR）、DeepSeek（点评）
- 对外访问需自备一个域名（用于 HTTPS）；纯内网用第 7 节方案可不需域名

> ⚠️ **重要**：浏览器的录音功能（getUserMedia）只在 `localhost` 或 `HTTPS` 下可用。
> 直接用 `http://服务器IP:3000` 访问时，麦克风会被浏览器禁用（上传音频文件不受影响）。
> 所以要么按第 5-6 节配 HTTPS，要么用第 7 节的 SSH 隧道。

---

## 1. 安装 Node.js 18+

Ubuntu 20.04 自带源的 Node 太旧（10.x），用 NodeSource 装 18/20：

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v    # 应 >= v18
```

（国内网络慢可改用 nvm + npmmirror，或给 apt/curl 走代理。）

## 2. 上传代码并安装依赖

把项目传到服务器 `/opt/listentome`（排除本地 `node_modules`）：

```bash
# 方式 A：git（推荐，代码在仓库里的话）
sudo mkdir -p /opt/listentome && sudo chown $USER /opt/listentome
git clone <你的仓库地址> /opt/listentome

# 方式 B：本机打包上传（在 Windows 本机执行）
# tar --exclude=node_modules --exclude=.env -czf listentome.tar.gz listentome
# scp listentome.tar.gz user@服务器IP:/tmp/
# 服务器上：tar -xzf /tmp/listentome.tar.gz -C /opt/listentome
```

安装依赖：

```bash
cd /opt/listentome
npm install --omit=dev
```

## 3. 配置环境变量

```bash
cp .env.example .env
nano .env
```

填入真实 Key：

```ini
ASR_BASE_URL=https://api.siliconflow.cn/v1
ASR_API_KEY=sk-xxxx
ASR_MODEL=FunAudioLLM/SenseVoice-V1.8
DEEPSEEK_API_KEY=sk-xxxx
PORT=3000
```

收紧权限（.env 里有密钥）：

```bash
chmod 600 .env
```

先手动跑一次验证（Ctrl+C 退出）：

```bash
node server.js
# 输出 ListenToMe 已启动: http://localhost:3000
# 且 ASR / LLM 两行都显示已配置（无 ❌）
```

## 4. systemd 常驻服务

创建 `/etc/systemd/system/listentome.service`：

```bash
sudo nano /etc/systemd/system/listentome.service
```

内容（注意 `WorkingDirectory` 必须是项目目录，dotenv 从这里读 `.env`）：

```ini
[Unit]
Description=ListenToMe AI speech coach
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/listentome
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
# 可选：用独立低权限用户运行（见下方说明）
# User=listentome

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now listentome
sudo systemctl status listentome     # 应为 active (running)
```

常用命令：

```bash
sudo systemctl restart listentome   # 重启
journalctl -u listentome -f          # 看实时日志
```

<details>
<summary>可选：专用低权限用户</summary>

```bash
sudo useradd -r -s /usr/sbin/nologin listentome
sudo chown -R listentome:listentome /opt/listentome
# 然后取消 service 文件里 User=listentome 的注释
sudo systemctl daemon-reload && sudo systemctl restart listentome
```
</details>

## 5. Nginx 反向代理

**方式 A：已有自己的 nginx.conf、想挂在子路径 `/ltm` 下**（如 `docs/nginx.conf` 所示）：

在 443 的 `server` 块里加：

```nginx
location = /ltm {
    return 301 /ltm/;
}
location ^~ /ltm/ {
    proxy_pass http://127.0.0.1:3000/;   # 末尾 / 剥掉 /ltm 前缀
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 30m;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

两个关键点：
- **必须用 `^~`**：普通 `location /ltm/` 会被配置里其他静态文件正则（`\.(js|css)$` 等）抢走匹配导致 404
- 应用前端已使用相对路径（`api/transcribe`、`style.css`），因此无需改代码即可挂在任意子路径下

然后重载：`sudo nginx -t && sudo systemctl reload nginx`，访问 `https://你的域名/ltm/`。

**方式 B：独立站点文件 + 子域名/根路径**：

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/listentome
```

内容：

```nginx
server {
    listen 80;
    server_name your.domain.com;      # 换成你的域名

    # 音频上传上限（服务端 multer 限 30MB，保持一致）
    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # 转写+LLM 分析耗时较长，放宽超时
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

启用：

```bash
sudo ln -s /etc/nginx/sites-available/listentome /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 6. HTTPS（Let's Encrypt）

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain.com
```

按提示完成后，`https://your.domain.com` 即可访问，麦克风可正常使用；certbot 会自动配置续期。

## 7. 没有域名？两种简化方案

**方案 A：SSH 隧道（推荐，安全省事）**——在自己电脑上执行：

```bash
ssh -L 3000:localhost:3000 user@服务器IP
```

然后本机浏览器打开 `http://localhost:3000`，浏览器视为 localhost，麦克风可用，全程加密，无需 Nginx/域名。

**方案 B：内网自签证书**：用 openssl 自签证书给 Nginx，浏览器需手动信任一次。家庭自用可行，手机上操作较麻烦，不展开。

## 8. 防火墙（可选）

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

不要放开 3000 端口，让流量一律走 Nginx。

## 9. 更新版本

```bash
cd /opt/listentome
git pull                    # 或重新上传覆盖
npm install --omit=dev
sudo systemctl restart listentome
```

## 10. 常见问题

| 现象 | 原因 / 处理 |
|------|-------------|
| 页面能开但点录音没权限 | 用了 `http://IP:3000` 访问（非安全上下文）。走第 6 节 HTTPS 或第 7 节隧道 |
| 日志报 `未配置 ASR_API_KEY` | `WorkingDirectory` 不对导致 `.env` 没被读到；确认 systemd 里路径正确 |
| 上传音频报 413 | Nginx `client_max_body_size` 太小，按第 5 节设为 30m |
| 转写/分析一直超时 | Nginx 超时太短（默认 60s）；确认 `proxy_read_timeout 300s`；也检查两个 Key 的额度 |
| `npm install` 卡住 | 国内网络，换源：`npm config set registry https://registry.npmmirror.com` |

## 架构小结

```
浏览器 (HTTPS)
   │  音频上传(≤30MB) / JSON
   ▼
Nginx :443 ──► Node (:3000, systemd 常驻)
                 ├─ /api/transcribe ──► 硅基流动 ASR
                 ├─ /api/analyze    ──► DeepSeek LLM
                 └─ 静态文件 public/
评测历史/账号：浏览器 IndexedDB（服务器不存用户数据）
```
