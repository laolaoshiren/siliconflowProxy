# SiliconFlow Proxy

> 硅基流动API管理和中转程序

一个用于管理和负载均衡硅基流动API密钥的代理服务，支持Web界面管理，具备智能错误处理和并发控制。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)
[![GitHub Actions](https://github.com/laolaoshiren/siliconflowProxy/workflows/Build%20and%20Push%20Docker%20Image/badge.svg)](https://github.com/laolaoshiren/siliconflowProxy/actions)
[![Docker Image](https://img.shields.io/badge/docker-ghcr.io/laolaoshiren/siliconflowproxy-blue)](https://github.com/laolaoshiren/siliconflowProxy/pkgs/container/siliconflowproxy)

## 功能特性

- ✅ **API密钥管理**：通过Web界面添加、删除和管理API密钥
- ✅ **负载均衡**：按添加时间顺序固定调用（从最早的开始）
- ✅ **智能错误处理**：自动检测余额、重试机制、状态标记
- ✅ **并发控制**：严格限制30分钟内只有一个并发请求，避免触发上游防御
- ✅ **状态监控**：实时显示API密钥状态（正常/欠费/错误）
- ✅ **Docker支持**：一键部署，生产环境友好

## 核心设计

### 并发控制机制

程序实现了严格的并发控制，确保30分钟内只有一个API调用。这是为了避免触发硅基流动的防御机制：
- 一个IP在30分钟内操作2个以上API会触发防御
- 导致API和IP封禁1小时左右

### 负载均衡策略

- 按API密钥的创建时间顺序调用
- 从最早添加的密钥开始使用
- 当前密钥无余额或出错时，自动切换到下一个

### 错误处理流程

1. 请求失败时，自动检查API余额
2. 如果有余额：标记为错误状态，等待后重试
3. 如果无余额：标记为欠费状态，切换到下一个API密钥
4. 记录所有使用情况和错误信息

## 安装

### 使用Docker（推荐）

#### 方式0：远程一键部署（最推荐，生产环境）

**一条命令完成所有部署：**

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/siliconflowProxy/main/install.sh | bash
```

**或者指定工作目录：**

```bash
export SILICONFLOW_PROXY_DIR=/opt/siliconflow-proxy
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/siliconflowProxy/main/install.sh | bash
```

**自定义端口和密码：**

```bash
export PORT=3838
export ADMIN_PASSWORD=your_custom_password
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/siliconflowProxy/main/install.sh | bash
```

**脚本功能：**
- ✅ 自动检测并安装 Docker（如需要）
- ✅ 自动检测并安装 Docker Compose（如需要）
- ✅ 自动创建 docker-compose 配置文件
- ✅ 自动生成管理员密码（如果未设置）
- ✅ 自动拉取最新 GitHub 构建镜像
- ✅ 自动停止旧容器并启动新容器
- ✅ 自动等待服务就绪并执行健康检查
- ✅ 显示所有重要信息（访问地址、管理员密码、管理命令等）

**部署后显示的信息包括：**
- 📌 服务访问地址（本地和网络）
- 🔑 管理员密码（高亮显示）
- 📊 容器运行状态
- 📝 常用管理命令（查看日志、启动、停止、重启等）
- 📁 数据目录位置
- 🔄 更新服务命令

**提示：**
- 如果未设置 `ADMIN_PASSWORD`，脚本会自动生成一个16位随机密码
- 密码会保存到 `.env` 文件和 `.deploy_password.txt` 文件（权限600）
- 建议部署完成后删除 `.deploy_password.txt` 文件
- 脚本会自动处理旧容器的停止和删除

#### 方式1：本地部署脚本

如果已经克隆了项目，可以使用本地部署脚本：

```bash
# 克隆项目
git clone https://github.com/laolaoshiren/siliconflowProxy.git
cd siliconflowProxy

# 运行部署脚本
chmod +x deploy.sh
./deploy.sh
```

#### 方式2：使用Docker Compose（本地构建）

```bash
# 克隆项目
git clone https://github.com/laolaoshiren/siliconflowProxy.git
cd siliconflowProxy

# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

#### 方式2：使用预构建镜像（推荐，生产环境）

项目已配置 GitHub Actions，每次提交到 main 分支会自动构建并推送 Docker 镜像到 GitHub Container Registry。

**首次部署（2步）：**

```bash
# 1. 拉取最新镜像
docker pull ghcr.io/laolaoshiren/siliconflowproxy:latest

# 2. 运行容器
docker run -d \
  --name siliconflow-proxy \
  -p 3838:3838 \
  -v $(pwd)/data:/app/data \
  -e PORT=3838 \
  -e ADMIN_PASSWORD=your_password \
  -e AUTO_QUERY_BALANCE_AFTER_CALLS=10 \
  --restart unless-stopped \
  ghcr.io/laolaoshiren/siliconflowproxy:latest
```

**更新项目（一条命令）：**

```bash
docker pull ghcr.io/laolaoshiren/siliconflowproxy:latest && docker stop siliconflow-proxy 2>/dev/null || true && docker rm siliconflow-proxy 2>/dev/null || true && docker run -d --name siliconflow-proxy -p 3838:3838 -v $(pwd)/data:/app/data -e PORT=3838 -e ADMIN_PASSWORD=your_password -e AUTO_QUERY_BALANCE_AFTER_CALLS=10 --restart unless-stopped ghcr.io/laolaoshiren/siliconflowproxy:latest
```

或者使用多行格式（更易读）：

```bash
docker pull ghcr.io/laolaoshiren/siliconflowproxy:latest && \
docker stop siliconflow-proxy 2>/dev/null || true && \
docker rm siliconflow-proxy 2>/dev/null || true && \
docker run -d \
  --name siliconflow-proxy \
  -p 3838:3838 \
  -v $(pwd)/data:/app/data \
  -e PORT=3838 \
  -e ADMIN_PASSWORD=your_password \
  -e AUTO_QUERY_BALANCE_AFTER_CALLS=10 \
  --restart unless-stopped \
  ghcr.io/laolaoshiren/siliconflowproxy:latest
```

**提示：** 
- 将 `your_password` 替换为你的实际管理员密码
- `2>/dev/null || true` 确保即使容器不存在也不会报错，适合首次部署和更新场景

**查看日志：**

```bash
docker logs -f siliconflow-proxy
```

#### 方式3：使用Docker Compose（预构建镜像）

创建 `docker-compose.prod.yml`：

```yaml
version: '3.8'

services:
  siliconflow-proxy:
    image: ghcr.io/laolaoshiren/siliconflowproxy:latest
    container_name: siliconflow-proxy
    ports:
      - "3838:3838"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    environment:
      - PORT=3838
      - NODE_ENV=production
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - AUTO_QUERY_BALANCE_AFTER_CALLS=${AUTO_QUERY_BALANCE_AFTER_CALLS:-10}
```

**首次部署：**
```bash
docker-compose -f docker-compose.prod.yml up -d
```

**更新项目：**
```bash
# 拉取最新镜像并重启
docker-compose -f docker-compose.prod.yml pull
docker-compose -f docker-compose.prod.yml up -d
```

### 本地开发

```bash
# 克隆项目
git clone https://github.com/your-username/siliconflow-proxy.git
cd siliconflow-proxy

# 安装依赖
npm install

# 启动服务
npm start

# 开发模式（自动重启）
npm run dev
```

服务启动后，访问 http://localhost:3000 打开管理界面。

## API使用

### 转发请求

将原本发送到硅基流动的请求改为发送到代理服务：

**原请求：**
```bash
POST https://api.siliconflow.cn/v1/chat/completions
```

**代理请求：**
```bash
POST http://localhost:3000/api/proxy/chat/completions
```

请求体和响应格式完全兼容硅基流动API。

### 管理接口

- `GET /api/manage/api-keys` - 获取所有API密钥
- `POST /api/manage/api-keys` - 添加API密钥
- `DELETE /api/manage/api-keys/:id` - 删除API密钥
- `PUT /api/manage/api-keys/:id/activate` - 激活API密钥

## 项目结构

```
.
├── server.js              # 主服务器文件
├── package.json           # 项目配置
├── Dockerfile             # Docker镜像配置
├── docker-compose.yml     # Docker Compose配置
├── db/
│   └── index.js          # 数据库操作
├── api/
│   ├── proxy.js          # API转发逻辑
│   └── manager.js        # 管理接口
├── utils/
│   └── apiManager.js     # API密钥管理工具
└── public/
    └── index.html        # Web管理界面
```

## 数据存储

使用SQLite本地数据库，数据文件存储在 `data/api_keys.db`。

## 注意事项

1. **并发限制**：程序严格限制30分钟内只有一个并发请求，这是为了避免触发上游防御
2. **API密钥安全**：请妥善保管API密钥，不要泄露
3. **数据备份**：定期备份 `data` 目录下的数据库文件
4. **端口配置**：默认端口3000，可通过环境变量 `PORT` 修改

## 环境变量

- `PORT`: 服务端口（默认：3000）
- `ADMIN_PASSWORD`: 管理员密码（用于保护管理接口，留空则不启用）
- `NODE_ENV`: 运行环境（production/development）
- `AUTO_QUERY_BALANCE_AFTER_CALLS`: API KEY自动查询余额配置（调用多少次后自动查询余额，0表示禁用，默认：10）

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License

Copyright (c) 2024 SiliconFlow Proxy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

