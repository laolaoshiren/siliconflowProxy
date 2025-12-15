require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const db = require('./db');
const apiProxy = require('./api/proxy');
const apiManager = require('./api/manager');

const app = express();
const PORT = process.env.PORT || 3838;

// 中间件
app.use(cors());

// 配置 body-parser（请求中断错误由错误处理中间件统一处理）
// 支持大模型请求，设置较大的请求体限制（100MB）
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// API路由
app.use('/api/proxy', apiProxy);
app.use('/api/manage', apiManager);

// 前端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 错误处理中间件：优雅处理请求中断等常见错误
// 注意：错误处理中间件必须放在所有路由之后
app.use((err, req, res, next) => {
  // 处理请求中断错误（用户取消请求、刷新页面等）
  // body-parser 会抛出 BadRequestError，错误消息包含 'request aborted'
  const isRequestAborted = 
    err.type === 'entity.parse.failed' || 
    err.type === 'request.aborted' ||
    err.name === 'BadRequestError' ||
    err.message === 'request aborted' ||
    (err.message && err.message.includes('aborted'));

  if (isRequestAborted) {
    // 静默处理，不输出错误日志（这是正常情况，用户可能刷新页面或取消请求）
    // 只在开发环境输出简短日志
    if (process.env.NODE_ENV !== 'production') {
      console.log('[请求中断] 客户端取消请求:', req.method, req.path);
    }
    if (!res.headersSent) {
      return res.status(400).json({ 
        error: { 
          message: '请求已中断',
          type: 'request_aborted' 
        } 
      });
    }
    return;
  }

  // 处理请求体过大错误
  if (err.type === 'entity.too.large' || 
      err.message === 'request entity too large' ||
      (err.message && err.message.includes('entity too large'))) {
    if (!res.headersSent) {
      return res.status(413).json({ 
        error: { 
          message: '请求体过大，最大支持100MB',
          type: 'payload_too_large' 
        } 
      });
    }
    return;
  }

  // 处理其他body解析错误
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    if (!res.headersSent) {
      return res.status(400).json({ 
        error: { 
          message: '请求体格式错误',
          type: 'invalid_json' 
        } 
      });
    }
    return;
  }

  // 其他错误正常处理
  console.error('服务器错误:', err.message);
  if (process.env.NODE_ENV === 'development') {
    console.error('错误堆栈:', err.stack);
  }
  if (!res.headersSent) {
    res.status(err.status || 500).json({ 
      error: { 
        message: err.message || '服务器内部错误',
        type: 'internal_error' 
      } 
    });
  }
});

// 初始化数据库和API keys
const apiKeyManager = require('./utils/apiManager');

db.init().then(async () => {
  console.log('数据库初始化完成');
  // 初始化加载API keys
  await apiKeyManager.loadActiveApiKeys();
  console.log('API keys加载完成');
  app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});

