const express = require('express');
const db = require('../db');
const { refreshApiKeys, queryBalance, checkAndUpdateAvailability } = require('../utils/apiManager');

const router = express.Router();

// 管理员密码验证中间件
const adminAuth = (req, res, next) => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    // 如果没有设置密码，直接通过
    return next();
  }
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '需要管理员密码' });
  }
  
  const token = authHeader.substring(7);
  if (token !== adminPassword) {
    return res.status(401).json({ success: false, message: '管理员密码错误' });
  }
  
  next();
};

// 检查是否需要密码
router.get('/check-auth', (req, res) => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  res.json({ 
    success: true, 
    requiresPassword: !!adminPassword 
  });
});

// 验证密码
router.post('/verify-password', (req, res) => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const { password } = req.body;
  
  if (!adminPassword) {
    return res.json({ success: true, message: '未设置密码' });
  }
  
  if (password === adminPassword) {
    return res.json({ success: true, message: '密码正确' });
  } else {
    return res.status(401).json({ success: false, message: '密码错误' });
  }
});

// 获取所有API keys
router.get('/api-keys', adminAuth, async (req, res) => {
  try {
    const keys = await db.getAllApiKeys();
    res.json({ success: true, data: keys });
  } catch (error) {
    console.error('获取API keys失败:', error);
    res.status(500).json({ success: false, message: '获取API keys失败' });
  }
});

// 添加API key（单个或批量）
router.post('/api-keys', adminAuth, async (req, res) => {
  try {
    const { api_key, api_keys } = req.body;
    
    // 支持批量添加
    const keysToAdd = api_keys ? api_keys.split('\n').map(k => k.trim()).filter(k => k) : [api_key?.trim()].filter(k => k);
    
    if (keysToAdd.length === 0) {
      return res.status(400).json({ success: false, message: 'API key不能为空' });
    }

    const results = [];
    const errors = [];
    
    for (const key of keysToAdd) {
      try {
        const result = await db.addApiKey(key);
        results.push(result);
      } catch (error) {
        if (error.message.includes('UNIQUE constraint')) {
          errors.push({ key: key.substring(0, 8) + '...', message: 'API key已存在' });
        } else {
          errors.push({ key: key.substring(0, 8) + '...', message: error.message });
        }
      }
    }
    
    await refreshApiKeys(); // 刷新活跃列表
    
    res.json({ 
      success: true, 
      data: results,
      added: results.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('添加API key失败:', error);
    res.status(500).json({ success: false, message: '添加API key失败' });
  }
});

// 查询API key余额
router.get('/api-keys/:id/balance', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: '无效的ID' });
    }

    const keyInfo = await db.getApiKeyById(id);
    if (!keyInfo) {
      return res.status(404).json({ success: false, message: 'API key不存在' });
    }

    const balanceInfo = await queryBalance(keyInfo.api_key);
    
    // 检查是否是API密钥无效的情况
    const isInvalidKey = balanceInfo.message && balanceInfo.message.includes('无效');
    
    // 更新数据库中的余额信息
    if (balanceInfo.success && balanceInfo.balance !== null) {
      // 如果是密钥无效，不更新余额为0，保持为null，只设置为不可用
      if (isInvalidKey) {
        // 密钥无效，不更新余额，保持为null，只设置为不可用（不改变status）
        await db.updateApiKeyAvailability(id, false);
        // 更新last_error用于前端显示判断
        await db.updateApiKeyStatus(id, keyInfo.status || 'active', balanceInfo.message);
        await refreshApiKeys();
      } else {
        // 正常情况，更新余额
      await db.updateApiKeyBalance(id, balanceInfo.balance);
      
      // 如果余额<1，自动改为不可用状态
      if (balanceInfo.balance < 1) {
        await db.updateApiKeyAvailability(id, false);
        await refreshApiKeys();
      } else {
        // 余额>=1，确保可用状态正确
        const currentKey = await db.getApiKeyById(id);
        if (currentKey && (currentKey.is_available === 0 || currentKey.is_available === null)) {
          // 如果之前不可用，现在余额充足，恢复为可用
          await db.updateApiKeyAvailability(id, true);
          await refreshApiKeys();
          }
        }
      }
    } else if (balanceInfo.success && balanceInfo.balance === null) {
      // 无法获取具体余额，但API key有效，保持当前状态
      // 不更新余额字段
    } else {
      // 查询失败，如果返回了余额0且不是密钥无效，更新
      if (balanceInfo.balance === 0 && !isInvalidKey) {
        await db.updateApiKeyBalance(id, 0);
        await db.updateApiKeyAvailability(id, false);
        await refreshApiKeys();
      } else if (isInvalidKey) {
        // 密钥无效，不更新余额，只设置为不可用（不改变status）
        await db.updateApiKeyAvailability(id, false);
        // 更新last_error用于前端显示判断
        await db.updateApiKeyStatus(id, keyInfo.status || 'active', balanceInfo.message);
        await refreshApiKeys();
      }
    }
    
    res.json({ 
      success: true, 
      data: {
        balance: balanceInfo.balance,
        hasBalance: balanceInfo.hasBalance,
        message: balanceInfo.message,
        checkedAt: new Date().toISOString()
      }
    });
    
    // 刷新列表以更新显示
    await refreshApiKeys();
  } catch (error) {
    console.error('查询余额失败:', error);
    res.status(500).json({ success: false, message: '查询余额失败' });
  }
});

// 批量删除API key
router.post('/api-keys/batch-delete', adminAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: '请提供要删除的ID列表' });
    }

    let deletedCount = 0;
    const errors = [];

    for (const id of ids) {
      const keyId = parseInt(id);
      if (isNaN(keyId)) {
        errors.push(`无效的ID: ${id}`);
        continue;
      }

      try {
        const result = await db.deleteApiKey(keyId);
        if (result.deleted) {
          deletedCount++;
        } else {
          errors.push(`ID ${keyId} 不存在`);
        }
      } catch (error) {
        errors.push(`删除ID ${keyId} 失败: ${error.message}`);
      }
    }

    await refreshApiKeys(); // 刷新活跃列表

    if (deletedCount > 0) {
      res.json({ 
        success: true, 
        message: `成功删除 ${deletedCount} 个API密钥${errors.length > 0 ? `，${errors.length} 个失败` : ''}`,
        deleted: deletedCount,
        errors: errors.length > 0 ? errors : undefined
      });
    } else {
      res.status(400).json({ 
        success: false, 
        message: '没有成功删除任何API密钥',
        errors: errors
      });
    }
  } catch (error) {
    console.error('批量删除API key失败:', error);
    res.status(500).json({ success: false, message: '批量删除API key失败' });
  }
});

// 删除API key
router.delete('/api-keys/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: '无效的ID' });
    }

    const result = await db.deleteApiKey(id);
    await refreshApiKeys(); // 刷新活跃列表
    
    if (result.deleted) {
      res.json({ success: true, message: '删除成功' });
    } else {
      res.status(404).json({ success: false, message: 'API key不存在' });
    }
  } catch (error) {
    console.error('删除API key失败:', error);
    res.status(500).json({ success: false, message: '删除API key失败' });
  }
});

// 更新API key状态（手动激活）
router.put('/api-keys/:id/activate', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: '无效的ID' });
    }

    await db.updateApiKeyStatus(id, 'active');
    await refreshApiKeys();
    
    res.json({ success: true, message: '激活成功' });
  } catch (error) {
    console.error('激活API key失败:', error);
    res.status(500).json({ success: false, message: '激活API key失败' });
  }
});

// 切换API key可用状态
router.put('/api-keys/:id/toggle-availability', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: '无效的ID' });
    }

    const keyInfo = await db.getApiKeyById(id);
    if (!keyInfo) {
      return res.status(404).json({ success: false, message: 'API key不存在' });
    }

    // 如果状态是error（异常），直接设置为可用状态，并清除error状态
    if (keyInfo.status === 'error') {
      await db.updateApiKeyAvailability(id, true);
      await db.updateApiKeyStatus(id, 'active', null);
      await refreshApiKeys();
      
      return res.json({ 
        success: true, 
        message: '异常状态已恢复为可用',
        is_available: true,
        status: 'active'
      });
    }

    // 正常状态下的切换逻辑
    const currentAvailability = keyInfo.is_available === 1 || keyInfo.is_available === null;
    const newAvailability = !currentAvailability;
    
    await db.updateApiKeyAvailability(id, newAvailability);
    await refreshApiKeys();
    
    res.json({ 
      success: true, 
      message: newAvailability ? '已设置为可用' : '已设置为不可用',
      is_available: newAvailability
    });
  } catch (error) {
    console.error('切换可用状态失败:', error);
    res.status(500).json({ success: false, message: '切换可用状态失败' });
  }
});

// 导出所有API keys
router.get('/api-keys/export', adminAuth, async (req, res) => {
  try {
    // 直接查询数据库获取完整的API keys（不隐藏）
    const keys = await db.getAllApiKeysForExport();
    
    // 每行一个
    const keysText = keys.map(k => k.api_key).join('\n');
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="api_keys.txt"');
    res.send(keysText);
  } catch (error) {
    console.error('导出API keys失败:', error);
    res.status(500).json({ success: false, message: '导出失败' });
  }
});

// 获取API key的错误日志
router.get('/api-keys/:id/logs', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: '无效的ID' });
    }

    const keyInfo = await db.getApiKeyById(id);
    if (!keyInfo) {
      return res.status(404).json({ success: false, message: 'API key不存在' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const logs = await db.getApiKeyErrorLogs(id, limit);
    
    res.json({ 
      success: true, 
      data: logs 
    });
  } catch (error) {
    console.error('获取错误日志失败:', error);
    res.status(500).json({ success: false, message: '获取错误日志失败' });
  }
});

// 验证API密钥
router.post('/api-keys/:id/verify', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: '无效的ID' });
    }

    const keyInfo = await db.getApiKeyById(id);
    if (!keyInfo) {
      return res.status(404).json({ success: false, message: 'API key不存在' });
    }

    const axios = require('axios');
    const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';
    
    // 测试请求体
    // 获取当前时间并格式化
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timeString = `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
    
    const testRequest = {
      model: 'deepseek-ai/DeepSeek-V3.2-Exp',
      messages: [
        {
          role: 'user',
          content: `你好，当前时间是：${timeString}`
        }
      ],
      max_tokens: 10,
      stream: false
    };

    let testResult = null;
    let errorMessage = null;
    let success = false;

    try {
      const response = await axios.post(
        `${SILICONFLOW_BASE_URL}/chat/completions`,
        testRequest,
        {
          headers: {
            'Authorization': `Bearer ${keyInfo.api_key}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000 // 30秒超时
        }
      );

      // 测试成功
      success = true;
      testResult = {
        status: response.status,
        statusText: response.statusText,
        data: response.data
      };

      // 验证成功后，只更新密钥状态为可用（不考虑余额）
      await db.updateApiKeyAvailability(id, true);
      await db.updateApiKeyStatus(id, 'active', null);
      
      // 记录成功日志
      const logMessage = JSON.stringify({
        type: 'verify_test',
        success: true,
        model: 'deepseek-ai/DeepSeek-V3.2-Exp',
        response: {
          status: response.status,
          statusText: response.statusText,
          data: response.data
        }
      }, null, 2);
      await db.recordUsage(id, true, logMessage);

      await refreshApiKeys();
      
      return res.json({ 
        success: true, 
        message: '验证成功：API密钥可以正常使用',
        data: {
          response: testResult
        }
      });
    } catch (error) {
      // 测试失败
      success = false;
      
      if (error.response) {
        // 上游返回了错误响应
        errorMessage = {
          type: 'verify_test',
          success: false,
          model: 'deepseek-ai/DeepSeek-V3.2-Exp',
          status: error.response.status,
          statusText: error.response.statusText,
          upstream_error: error.response.data || error.response.statusText,
          error_message: error.message
        };
      } else if (error.request) {
        // 请求发送了但没有收到响应
        errorMessage = {
          type: 'verify_test',
          success: false,
          model: 'deepseek-ai/DeepSeek-V3.2-Exp',
          error_message: '请求超时或网络错误',
          details: error.message
        };
      } else {
        // 其他错误
        errorMessage = {
          type: 'verify_test',
          success: false,
          model: 'deepseek-ai/DeepSeek-V3.2-Exp',
          error_message: error.message
        };
      }

      // 记录失败日志
      const logMessage = JSON.stringify(errorMessage, null, 2);
      await db.recordUsage(id, false, logMessage);

      return res.json({ 
        success: false, 
        message: '验证失败：API密钥无法正常使用',
        data: {
          error: errorMessage
        }
      });
    }
  } catch (error) {
    console.error('验证API key失败:', error);
    res.status(500).json({ success: false, message: '验证API key失败: ' + error.message });
  }
});

// 获取当前正在使用的API key ID
router.get('/current-api-key', adminAuth, async (req, res) => {
  try {
    const { getCurrentApiKeyId } = require('../utils/apiManager');
    const currentKeyId = getCurrentApiKeyId();
    
    res.json({ 
      success: true, 
      data: {
        current_api_key_id: currentKeyId
      }
    });
  } catch (error) {
    console.error('获取当前API key失败:', error);
    res.status(500).json({ success: false, message: '获取当前API key失败' });
  }
});

module.exports = router;

