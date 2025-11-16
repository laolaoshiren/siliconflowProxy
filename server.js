const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./db');
const apiProxy = require('./api/proxy');
const apiManager = require('./api/manager');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// API路由
app.use('/api/proxy', apiProxy);
app.use('/api/manage', apiManager);

// 前端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 初始化数据库和API keys
const apiManager = require('./utils/apiManager');

db.init().then(async () => {
  console.log('数据库初始化完成');
  // 初始化加载API keys
  await apiManager.loadActiveApiKeys();
  console.log('API keys加载完成');
  app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});

