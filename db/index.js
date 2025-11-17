const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '../data', 'api_keys.db');

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      const dbDir = path.dirname(DB_PATH);
      
      // 确保数据目录存在
      if (!fs.existsSync(dbDir)) {
        try {
          fs.mkdirSync(dbDir, { recursive: true });
        } catch (mkdirErr) {
          reject(new Error(`创建数据目录失败: ${dbDir}。错误: ${mkdirErr.message}`));
          return;
        }
      }

      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          reject(new Error(`无法打开数据库文件: ${DB_PATH}。错误: ${err.message}`));
        } else {
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async createTables() {
    return new Promise((resolve, reject) => {
      const queries = [
        `CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          api_key TEXT NOT NULL UNIQUE,
          status TEXT DEFAULT 'active' CHECK(status IN ('active', 'insufficient', 'error')),
          is_available INTEGER DEFAULT 1 CHECK(is_available IN (0, 1)),
          balance REAL DEFAULT 0,
          balance_checked_at DATETIME,
          call_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME,
          error_count INTEGER DEFAULT 0,
          last_error TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS api_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          api_key_id INTEGER,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          success INTEGER DEFAULT 0,
          error TEXT,
          FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
        )`,
        `CREATE TABLE IF NOT EXISTS ip_blacklist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          unblock_at DATETIME NOT NULL,
          reason TEXT
        )`
      ];

      let completed = 0;
      queries.forEach((query) => {
        this.db.run(query, (err) => {
          if (err) {
            reject(err);
          } else {
            completed++;
            if (completed === queries.length) {
              // 迁移旧数据库结构：添加新字段（如果不存在）
              this.migrateDatabase().then(resolve).catch(resolve); // 即使迁移失败也继续
            }
          }
        });
      });
    });
  }

  async migrateDatabase() {
    return new Promise((resolve, reject) => {
      const migrations = [
        { sql: `ALTER TABLE api_keys ADD COLUMN balance REAL DEFAULT 0`, field: 'balance' },
        { sql: `ALTER TABLE api_keys ADD COLUMN balance_checked_at DATETIME`, field: 'balance_checked_at' },
        { sql: `ALTER TABLE api_keys ADD COLUMN is_available INTEGER DEFAULT 1`, field: 'is_available' },
        { sql: `ALTER TABLE api_keys ADD COLUMN call_count INTEGER DEFAULT 0`, field: 'call_count' }
      ];
      
      let completed = 0;
      migrations.forEach((migration) => {
        this.db.run(migration.sql, (err) => {
          // 忽略已存在的错误
          if (err && !err.message.includes('duplicate column')) {
            // 如果是balance字段从TEXT改为REAL，需要特殊处理
            if (migration.field === 'balance' && err.message.includes('cannot change')) {
              // 先删除旧字段，再添加新字段（需要手动处理，这里只记录）
              console.warn('需要手动迁移balance字段类型');
            } else {
              console.error(`迁移${migration.field}字段失败:`, err);
            }
          }
          completed++;
          if (completed === migrations.length) {
            resolve();
          }
        });
      });
    });
  }

  async addApiKey(apiKey) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO api_keys (api_key) VALUES (?)',
        [apiKey],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve({ id: this.lastID, apiKey });
          }
        }
      );
    });
  }

  async deleteApiKey(id) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM api_keys WHERE id = ?', [id], function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ deleted: this.changes > 0 });
        }
      });
    });
  }

  async getAllApiKeys() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT id, api_key, status, is_available, balance, balance_checked_at, call_count, created_at, last_used_at, error_count, last_error FROM api_keys ORDER BY created_at ASC',
        [],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            // 隐藏API key的敏感部分，但保留完整key用于复制
            const safeRows = rows.map(row => ({
              ...row,
              full_api_key: row.api_key, // 保存完整的API key用于复制
              api_key: row.api_key ? `${row.api_key.substring(0, 8)}...${row.api_key.substring(row.api_key.length - 4)}` : '',
              is_available: row.is_available === 1 || row.is_available === null, // 兼容null值
              balance: row.balance !== null ? parseFloat(row.balance) : null
            }));
            resolve(safeRows);
          }
        }
      );
    });
  }

  async getAllApiKeysForExport() {
    return new Promise((resolve, reject) => {
      // 导出时返回完整的API keys（不隐藏）
      this.db.all(
        'SELECT api_key FROM api_keys ORDER BY created_at ASC',
        [],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  async getActiveApiKeys() {
    return new Promise((resolve, reject) => {
      // 只返回可用状态的API keys（is_available = 1）
      this.db.all(
        'SELECT id, api_key, status, created_at, last_used_at FROM api_keys WHERE is_available = 1 ORDER BY created_at ASC',
        [],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  async getApiKeyById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM api_keys WHERE id = ?',
        [id],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  async updateApiKeyStatus(id, status, error = null) {
    return new Promise((resolve, reject) => {
      const updateError = error ? 
        this.db.run(
          'UPDATE api_keys SET status = ?, error_count = error_count + 1, last_error = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
          [status, error, id],
          (err) => err ? reject(err) : resolve()
        ) :
        this.db.run(
          'UPDATE api_keys SET status = ?, last_used_at = CURRENT_TIMESTAMP, error_count = 0, last_error = NULL WHERE id = ?',
          [status, id],
          (err) => err ? reject(err) : resolve()
        );
    });
  }

  async updateApiKeyBalance(id, balance) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE api_keys SET balance = ?, balance_checked_at = CURRENT_TIMESTAMP WHERE id = ?',
        [balance, id],
        (err) => err ? reject(err) : resolve()
      );
    });
  }

  async updateApiKeyAvailability(id, isAvailable) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE api_keys SET is_available = ? WHERE id = ?',
        [isAvailable ? 1 : 0, id],
        (err) => err ? reject(err) : resolve()
      );
    });
  }

  async incrementCallCount(id) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE api_keys SET call_count = call_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id],
        (err) => err ? reject(err) : resolve()
      );
    });
  }

  async recordUsage(apiKeyId, success, error = null) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO api_usage (api_key_id, success, error) VALUES (?, ?, ?)',
        [apiKeyId, success ? 1 : 0, error],
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // 检查IP是否被拉黑
  async isIpBlocked() {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM ip_blacklist WHERE unblock_at > CURRENT_TIMESTAMP ORDER BY blocked_at DESC LIMIT 1',
        [],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row || null);
          }
        }
      );
    });
  }

  // 添加IP拉黑记录（30分钟）
  async blockIp(reason = 'IP被硅基流动拉黑') {
    return new Promise((resolve, reject) => {
      const unblockAt = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
      this.db.run(
        'INSERT INTO ip_blacklist (unblock_at, reason) VALUES (?, ?)',
        [unblockAt, reason],
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // 清除所有过期的拉黑记录
  async clearExpiredBlocks() {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM ip_blacklist WHERE unblock_at <= CURRENT_TIMESTAMP',
        [],
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  // 获取API key的错误日志
  async getApiKeyErrorLogs(apiKeyId, limit = 50) {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT id, timestamp, success, error FROM api_usage WHERE api_key_id = ? AND success = 0 ORDER BY timestamp DESC LIMIT ?',
        [apiKeyId, limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

const db = new Database();

module.exports = db;

