const express = require('express');
const db = require('../db');
const { refreshApiKeys } = require('../utils/apiManager');

const router = express.Router();

// 获取所有API keys
router.get('/api-keys', async (req, res) => {
  try {
    const keys = await db.getAllApiKeys();
    res.json({ success: true, data: keys });
  } catch (error) {
    console.error('获取API keys失败:', error);
    res.status(500).json({ success: false, message: '获取API keys失败' });
  }
});

// 添加API key
router.post('/api-keys', async (req, res) => {
  try {
    const { api_key, name } = req.body;
    
    if (!api_key || !api_key.trim()) {
      return res.status(400).json({ success: false, message: 'API key不能为空' });
    }

    const result = await db.addApiKey(api_key.trim(), name || '');
    await refreshApiKeys(); // 刷新活跃列表
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('添加API key失败:', error);
    if (error.message.includes('UNIQUE constraint')) {
      res.status(400).json({ success: false, message: 'API key已存在' });
    } else {
      res.status(500).json({ success: false, message: '添加API key失败' });
    }
  }
});

// 删除API key
router.delete('/api-keys/:id', async (req, res) => {
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
router.put('/api-keys/:id/activate', async (req, res) => {
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

module.exports = router;

