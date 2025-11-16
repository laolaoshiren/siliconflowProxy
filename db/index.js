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
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
          reject(err);
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
          name TEXT,
          status TEXT DEFAULT 'active' CHECK(status IN ('active', 'insufficient', 'error')),
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
              resolve();
            }
          }
        });
      });
    });
  }

  async addApiKey(apiKey, name = '') {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT INTO api_keys (api_key, name) VALUES (?, ?)',
        [apiKey, name],
        function(err) {
          if (err) {
            reject(err);
          } else {
            resolve({ id: this.lastID, apiKey, name });
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
        'SELECT id, api_key, name, status, created_at, last_used_at, error_count, last_error FROM api_keys ORDER BY created_at ASC',
        [],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            // 隐藏API key的敏感部分
            const safeRows = rows.map(row => ({
              ...row,
              api_key: row.api_key ? `${row.api_key.substring(0, 8)}...${row.api_key.substring(row.api_key.length - 4)}` : ''
            }));
            resolve(safeRows);
          }
        }
      );
    });
  }

  async getActiveApiKeys() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT id, api_key, name, status, created_at, last_used_at FROM api_keys WHERE status = ? ORDER BY created_at ASC',
        ['active'],
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

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

const db = new Database();

module.exports = db;

