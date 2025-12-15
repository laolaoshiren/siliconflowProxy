# 开发环境使用指南

## npm run dev 改进说明

### 功能特性

改进后的 `npm run dev` 命令具有以下特性：

1. **自动清理旧进程**
   - 通过PID文件清理
   - 通过端口清理（3838）
   - 通过进程名清理（node server.js, nodemon）
   - 确保每次启动都使用最新代码

2. **代码热重载**
   - 使用 nodemon 自动监控文件变化
   - 代码修改后自动重启服务
   - 提高开发效率

3. **优雅退出**
   - 支持 Ctrl+C 优雅停止
   - 自动清理PID文件
   - 确保资源正确释放

4. **启动信息显示**
   - 显示端口号
   - 显示管理员密码
   - 显示访问地址

### 使用方法

```bash
# 启动开发服务器
npm run dev
```

### 工作原理

1. 运行 `npm run dev` 时，会执行 `scripts/dev.js`
2. `dev.js` 首先检查并清理所有旧进程
3. 然后使用 nodemon 启动 server.js
4. nodemon 监控文件变化，自动重启服务

### 注意事项

- 确保端口 3838 未被其他程序占用
- 确保 .env 文件配置正确
- 使用 Ctrl+C 停止服务，不要直接 kill 进程

## 客户端API密钥管理功能

### 功能说明

客户端API密钥具有双重用途：
1. **管理员密码**：用于网页登录和管理接口认证
2. **客户端API密钥**：大模型客户端访问代理服务时使用

### API接口

- **GET** `/api/manage/client-api-key` - 获取客户端API密钥
- **PUT** `/api/manage/client-api-key` - 更新客户端API密钥

### 使用示例

```bash
# 获取客户端API密钥
curl -X GET http://localhost:3838/api/manage/client-api-key \
  -H "Authorization: Bearer admin"

# 更新客户端API密钥
curl -X PUT http://localhost:3838/api/manage/client-api-key \
  -H "Authorization: Bearer admin" \
  -H "Content-Type: application/json" \
  -d '{"api_key":"new_password_here"}'
```

### 注意事项

- 修改密钥后需要重启服务才能完全生效
- 修改密钥后需要使用新密钥重新登录管理界面
- 客户端需要使用新密钥访问代理服务

