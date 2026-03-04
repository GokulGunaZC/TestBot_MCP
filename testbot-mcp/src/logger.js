/**
 * Central Logger for TestBot MCP Server
 * Outputs rich logs to stderr (required for MCP) and robustly to files.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

class Logger {
  static initialized = false;
  static logsDir;
  static mcpLogPath;
  static errorLogPath;

  static initialize() {
    if (this.initialized) return;

    // Use current working directory for logs (often project root)
    this.logsDir = path.join(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true });
      }
    } catch (e) {
      // Fallback to minimal logging if no permission
      console.error(`[Testbot] [Logger] Failed to create logs directory: ${e.message}`);
    }

    this.mcpLogPath = path.join(this.logsDir, 'mcp.log');
    this.errorLogPath = path.join(this.logsDir, 'error.log');

    // Optionally rotate large old logs
    this._rotateLogFile(this.mcpLogPath);
    this._rotateLogFile(this.errorLogPath);

    this.initialized = true;
    this.info('Logger', 'Central logging initialized');
  }

  static _rotateLogFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        // Rotate if larger than 5MB
        if (stats.size > 5 * 1024 * 1024) {
          const parsed = path.parse(filePath);
          const backupPath = path.join(parsed.dir, `${parsed.name}.old${parsed.ext}`);
          fs.renameSync(filePath, backupPath);
        }
      }
    } catch (e) {
      // Ignore rotation errors
    }
  }

  static _formatMetadata(metadata) {
    if (!metadata) return '';
    if (typeof metadata === 'object') {
      return Object.keys(metadata).length > 0 ? '\n' + util.inspect(metadata, { depth: 4, colors: true }) : '';
    }
    return ` | ${metadata}`;
  }

  static _formatFileMetadata(metadata) {
    if (!metadata) return '';
    if (typeof metadata === 'object') {
      return Object.keys(metadata).length > 0 ? '\n' + JSON.stringify(metadata, null, 2) : '';
    }
    return ` | ${metadata}`;
  }

  static _log(level, moduleName, message, metadata = null) {
    if (!this.initialized) {
      this.initialize();
    }

    const timestamp = new Date().toISOString();
    const formattedMeta = this._formatMetadata(metadata);
    
    // For MCP, we MUST use stderr. stdout breaks the JSON-RPC pipe.
    const consoleOutput = `[${timestamp}] [${level}] [${moduleName}] ${message}${formattedMeta}\n`;
    process.stderr.write(consoleOutput);

    // File logging
    if (this.logsDir) {
      const fileMeta = this._formatFileMetadata(metadata);
      const fileOutput = `[${timestamp}] [${level}] [${moduleName}] ${message}${fileMeta}\n`;
      
      try {
        fs.appendFileSync(this.mcpLogPath, fileOutput);
        
        if (level === 'ERROR') {
          fs.appendFileSync(this.errorLogPath, fileOutput);
        }
      } catch (e) {
        // Silent fail on file write issues to prevent crashing the server
      }
    }
  }

  static info(moduleName, message, metadata = null) {
    this._log('INFO', moduleName, message, metadata);
  }

  static warn(moduleName, message, metadata = null) {
    this._log('WARN', moduleName, message, metadata);
  }

  static error(moduleName, message, error = null, metadata = null) {
    let errorMetadata = metadata || {};
    if (error) {
      if (error instanceof Error) {
        errorMetadata.errorMessage = error.message;
        errorMetadata.stack = error.stack;
      } else {
        errorMetadata.errorPayload = error;
      }
    }
    this._log('ERROR', moduleName, message, errorMetadata);
  }

  static debug(moduleName, message, metadata = null) {
    // We can conditionally disable debug later, but for now log everything
    this._log('DEBUG', moduleName, message, metadata);
  }

  static mcp(moduleName, message, metadata = null) {
    // Specialized level for MCP protocol events
    this._log('MCP', moduleName, message, metadata);
  }
}

module.exports = Logger;
