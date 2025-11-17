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

// 查询API余额并返回余额信息
// 参考文档: https://docs.siliconflow.cn/cn/api-reference/userinfo/get-user-info
async function queryBalance(apiKey) {
  try {
    // 使用硅基流动官方API查询用户信息（包含余额）
    const response = await axios.get(
      `${SILICONFLOW_BASE_URL}/user/info`,
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    if (response.status === 200 && response.data) {
      const data = response.data;
      
      // 检查响应格式
      if (data.code === 20000 && data.status === true && data.data) {
        const userData = data.data;
        
        // 优先使用 balance（可用余额），如果没有则使用 totalBalance（总余额）
        const balanceStr = userData.balance || userData.totalBalance || '0';
        const balance = parseFloat(balanceStr);
        
        if (!isNaN(balance)) {
          return {
            success: true,
            hasBalance: balance >= 0.5,
            balance: balance,
            message: `余额: ¥${balance.toFixed(2)}${userData.totalBalance ? ` (总余额: ¥${parseFloat(userData.totalBalance).toFixed(2)})` : ''}`
          };
        }
      }
      
      // 如果响应格式不符合预期，尝试直接获取余额
      if (data.data && (data.data.balance || data.data.totalBalance)) {
        const balanceStr = data.data.balance || data.data.totalBalance || '0';
        const balance = parseFloat(balanceStr);
        
        if (!isNaN(balance)) {
          return {
            success: true,
            hasBalance: balance >= 0.5,
            balance: balance,
            message: `余额: ¥${balance.toFixed(2)}`
          };
        }
      }
      
      return {
        success: false,
        hasBalance: false,
        balance: null,
        message: '无法解析余额信息'
      };
    }
    
    return { 
      success: false, 
      hasBalance: false, 
      balance: null,
      message: '无法确定余额状态'
    };
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      if (status === 401 || status === 403) {
        return { 
          success: true, 
          hasBalance: false, 
          balance: 0,
          message: 'API密钥无效或余额不足'
        };
      }
      
      // 尝试解析错误响应
      if (error.response.data) {
        const errorMsg = typeof error.response.data === 'string' 
          ? error.response.data 
          : error.response.data.message || `请求失败: ${status}`;
        return { 
          success: false, 
          hasBalance: false, 
          balance: null,
          message: errorMsg
        };
      }
      
      return { 
        success: false, 
        hasBalance: false, 
        balance: null,
        message: `请求失败: ${status}`
      };
    }
    return { 
      success: false, 
      hasBalance: false, 
      balance: null,
      message: error.message || '网络错误'
    };
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

// 检查并更新API key可用状态
// 规则：失败3次且余额<1才改为不可用
async function checkAndUpdateAvailability(id) {
  const keyInfo = await db.getApiKeyById(id);
  if (!keyInfo) return;
  
  const errorCount = keyInfo.error_count || 0;
  const balance = keyInfo.balance !== null ? parseFloat(keyInfo.balance) : null;
  const isAvailable = keyInfo.is_available === 1 || keyInfo.is_available === null;
  
  // 如果失败3次且余额<1，设置为不可用
  if (errorCount >= 3 && balance !== null && balance < 1) {
    await db.updateApiKeyAvailability(id, false);
    await loadActiveApiKeys();
  } else if (!isAvailable && (errorCount < 3 || balance === null || balance >= 1)) {
    // 如果之前不可用，但现在条件不满足，恢复为可用
    await db.updateApiKeyAvailability(id, true);
    await loadActiveApiKeys();
  }
}

// 当添加或删除API key时，重新加载列表
async function refreshApiKeys() {
  await loadActiveApiKeys();
}

// 检查错误响应中是否包含"busy"字样（不区分大小写）
function isBusyError(error) {
  if (!error || !error.response) return false;
  
  const responseData = error.response.data;
  if (!responseData) return false;
  
  // 检查响应体中的文本
  let responseText = '';
  
  if (typeof responseData === 'string') {
    responseText = responseData;
  } else if (typeof responseData === 'object') {
    // 安全地转换为字符串，避免循环引用
    try {
      // 先尝试提取常见的错误消息字段
      if (responseData.error && typeof responseData.error === 'object') {
        if (responseData.error.message) {
          responseText += String(responseData.error.message);
        }
        if (responseData.error.type) {
          responseText += ' ' + String(responseData.error.type);
        }
      }
      if (responseData.message) {
        responseText += ' ' + String(responseData.message);
      }
      if (responseData.msg) {
        responseText += ' ' + String(responseData.msg);
      }
      
      // 如果还没有找到文本，尝试安全地序列化（排除循环引用）
      if (!responseText) {
        const seen = new WeakSet();
        responseText = JSON.stringify(responseData, (key, value) => {
          // 排除可能导致循环引用的对象
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular]';
            }
            seen.add(value);
            // 排除 socket、request 等可能导致循环引用的属性
            if (key === 'socket' || key === '_httpMessage' || key === 'request' || key === 'response') {
              return '[Object]';
            }
          }
          return value;
        });
      }
    } catch (e) {
      // 如果序列化失败，尝试使用 toString
      try {
        responseText = String(responseData);
      } catch (e2) {
        // 如果都失败了，返回 false
        return false;
      }
    }
  } else {
    responseText = String(responseData);
  }
  
  return /busy/i.test(responseText);
}

// 获取错误消息（用于返回给客户端）
function getErrorMessage(error) {
  if (!error) return '未知错误';
  
  if (error.response) {
    const status = error.response.status;
    const data = error.response.data;
    
    // 尝试从响应中提取错误消息（安全地处理，避免循环引用）
    if (data) {
      try {
        if (typeof data === 'string') {
          return data;
        }
        if (data && typeof data === 'object') {
          // 优先提取常见的错误消息字段
          if (data.error && typeof data.error === 'object' && data.error.message) {
            return String(data.error.message);
          }
          if (data.message) {
            return String(data.message);
          }
          if (data.msg) {
            return String(data.msg);
          }
          if (data.error && typeof data.error === 'string') {
            return String(data.error);
          }
        }
      } catch (e) {
        // 如果提取失败，继续使用状态码
        console.warn('提取错误消息失败:', e.message);
      }
    }
    
    // 根据状态码返回默认消息
    switch (status) {
      case 400:
        return '请求参数错误';
      case 401:
        return 'API密钥无效或未授权';
      case 403:
        return 'API密钥权限不足或余额不足';
      case 404:
        return '请求的资源不存在';
      case 429:
        return '请求频率过高，请稍后重试';
      case 500:
        return '服务器内部错误';
      case 502:
        return '网关错误';
      case 503:
        return '服务暂时不可用';
      default:
        return `请求失败 (HTTP ${status})`;
    }
  }
  
  if (error.code === 'ECONNABORTED') {
    return '请求超时';
  }
  
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return '无法连接到服务器';
  }
  
  // 安全地获取 error.message
  try {
    return error.message || '网络错误';
  } catch (e) {
    return '网络错误';
  }
}

// 获取当前正在使用的API key ID
function getCurrentApiKeyId() {
  return currentApiKeyId;
}

// 设置当前正在使用的API key ID（供外部模块使用）
function setCurrentApiKeyId(id) {
  currentApiKeyId = id;
}

module.exports = {
  getCurrentApiKey,
  switchToNextApiKey,
  checkBalance,
  queryBalance,
  markApiKeyStatus,
  checkAndUpdateAvailability,
  refreshApiKeys,
  loadActiveApiKeys,
  isBusyError,
  getErrorMessage,
  getCurrentApiKeyId,
  setCurrentApiKeyId
};

