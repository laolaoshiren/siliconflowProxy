const axios = require('axios');
const db = require('../db');

const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

// 当前使用的API key（按创建时间顺序，从最早的开始）
let currentApiKeyId = null;
let activeApiKeys = [];

// 初始化：加载所有活跃的API keys
async function loadActiveApiKeys() {
  activeApiKeys = await db.getActiveApiKeys();
  // 如果当前key不在列表中，重置为null
  if (currentApiKeyId) {
    const stillExists = activeApiKeys.find(k => k.id === currentApiKeyId);
    if (!stillExists) {
      currentApiKeyId = null;
    }
  }
  return activeApiKeys;
}

// 获取当前使用的API key（如果当前key无余额，则切换到下一个）
async function getCurrentApiKey() {
  // 如果列表为空，重新加载
  if (activeApiKeys.length === 0) {
    await loadActiveApiKeys();
  }

  if (activeApiKeys.length === 0) {
    return null;
  }

  // 如果当前有使用的key，检查它是否仍然可用
  if (currentApiKeyId) {
    const currentKey = await db.getApiKeyById(currentApiKeyId);
    if (currentKey && currentKey.status === 'active') {
      return currentKey;
    }
    // 当前key不可用，清除并切换到下一个
    currentApiKeyId = null;
  }

  // 没有当前key或当前key不可用，从最早的开始查找
  for (const key of activeApiKeys) {
    const fullKeyInfo = await db.getApiKeyById(key.id);
    if (fullKeyInfo && fullKeyInfo.status === 'active') {
      currentApiKeyId = fullKeyInfo.id;
      return fullKeyInfo;
    }
  }

  return null;
}

// 切换到下一个API key（当前key无余额时调用）
async function switchToNextApiKey() {
  if (activeApiKeys.length === 0) {
    await loadActiveApiKeys();
  }

  if (activeApiKeys.length === 0) {
    currentApiKeyId = null;
    return null;
  }

  // 找到当前key在列表中的位置
  let currentIndex = -1;
  if (currentApiKeyId) {
    currentIndex = activeApiKeys.findIndex(k => k.id === currentApiKeyId);
  }

  // 从下一个位置开始查找
  const startIndex = currentIndex + 1;
  for (let i = 0; i < activeApiKeys.length; i++) {
    const index = (startIndex + i) % activeApiKeys.length;
    const key = activeApiKeys[index];
    const fullKeyInfo = await db.getApiKeyById(key.id);
    if (fullKeyInfo && fullKeyInfo.status === 'active') {
      currentApiKeyId = fullKeyInfo.id;
      return fullKeyInfo;
    }
  }

  // 没有可用的key
  currentApiKeyId = null;
  return null;
}

// 检查API余额（通过调用一个简单的模型列表接口或余额查询接口）
async function checkBalance(apiKey) {
  try {
    // 尝试调用一个轻量级的接口来检查API key是否有效
    // 注意：硅基流动可能没有直接的余额查询接口，这里通过尝试调用模型列表来验证
    const response = await axios.get(
      `${SILICONFLOW_BASE_URL}/models`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    // 如果请求成功，认为有余额
    return response.status === 200;
  } catch (error) {
    // 如果是401或403，可能是余额不足或API key无效
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      return false;
    }
    // 其他错误，可能是网络问题，暂时认为有余额
    return true;
  }
}

// 标记API key状态
async function markApiKeyStatus(id, status, error = null) {
  await db.updateApiKeyStatus(id, status, error);
  
  // 如果状态变为非活跃，重新加载列表
  if (status !== 'active') {
    await loadActiveApiKeys();
  }
}

// 当添加或删除API key时，重新加载列表
async function refreshApiKeys() {
  await loadActiveApiKeys();
}

module.exports = {
  getCurrentApiKey,
  switchToNextApiKey,
  checkBalance,
  markApiKeyStatus,
  refreshApiKeys,
  loadActiveApiKeys
};

