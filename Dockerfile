FROM node:18-alpine

WORKDIR /app

# 复制package文件
COPY package*.json ./

# 只安装生产依赖
RUN npm ci --only=production && npm cache clean --force

# 复制应用代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3838

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3838/api/proxy/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# 启动应用（以root用户运行，简化生产环境部署）
CMD ["node", "server.js"]

