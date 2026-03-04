/**
 * Configuration UI Launcher
 * Launches a browser-based configuration form and returns user input
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Logger = require('./logger');

class ConfigUILauncher {
  constructor(config = {}) {
    this.config = {
      port: config.port || 54321,
      timeout: config.timeout || 300000, // 5 minutes
      ...config,
    };
    
    this.server = null;
    this.resolveConfig = null;
    this.rejectConfig = null;
  }

  /**
   * Launch the configuration UI and wait for user input
   * @param {Object} projectInfo - Auto-detected project information
   * @returns {Promise<Object>} User configuration
   */
  async launch(projectInfo = {}) {
    return new Promise(async (resolve, reject) => {
      this.resolveConfig = resolve;
      this.rejectConfig = reject;
      
      try {
        // Start server
        await this.startServer(projectInfo);
        Logger.info('ConfigUILauncher', `Server started`, { port: this.config.port });
        
        // Build URL with project info
        const params = new URLSearchParams({
          projectPath: projectInfo.projectPath || '',
          projectName: projectInfo.projectName || 'Project',
          framework: projectInfo.framework || 'auto',
          baseURL: projectInfo.baseURL || 'http://localhost:3000',
          port: projectInfo.port || '3000',
          startCommand: projectInfo.startCommand || 'npm run dev',
          serverPort: String(this.config.port),
        });
        
        const configURL = `http://localhost:${this.config.port}/config-form.html?${params.toString()}`;
        Logger.info('ConfigUILauncher', `Opening configuration form`, { url: configURL });
        
        // Open in browser
        try {
          const { exec } = require('child_process');
          const cmd = process.platform === 'win32'
            ? `start "" "${configURL}"`
            : (process.platform === 'darwin' ? `open "${configURL}"` : `xdg-open "${configURL}"`);
          exec(cmd, { windowsHide: true }, () => {});
          Logger.info('ConfigUILauncher', 'Configuration form opened in browser');
        } catch (error) {
          Logger.warn('ConfigUILauncher', `Could not auto-open browser`, { error: error.message, url: configURL });
          // Don't reject here, let the developer open the URL manually within the 5 minute window
        }
        
        // Set timeout
        setTimeout(() => {
          if (this.server) {
            this.cleanup();
            reject(new Error('Configuration timeout - user did not complete the form within 5 minutes'));
          }
        }, this.config.timeout);
        
      } catch (error) {
        Logger.error('ConfigUILauncher', `Launch critical error`, error);
        this.cleanup();
        reject(error);
      }
    });
  }

  /**
   * Start the HTTP server
   */
  startServer(projectInfo) {
    return new Promise((resolve, reject) => {
      // Find dashboard directory
      const dashboardPaths = [
        path.join(__dirname, '../dashboard/public'),
        path.join(__dirname, '../../dashboard/public'),
        path.join(__dirname, '../../../dashboard/public'),
        path.join(process.cwd(), 'dashboard/public'),
      ];
      
      let dashboardDir = null;
      for (const p of dashboardPaths) {
        if (fs.existsSync(path.join(p, 'config-form.html'))) {
          dashboardDir = p;
          break;
        }
      }
      
      if (!dashboardDir) {
        Logger.error('ConfigUILauncher', 'Configuration form not found', new Error('Missing dashboard/public/config-form.html'), { paths: dashboardPaths });
        return reject(new Error('Configuration form not found. Please ensure dashboard/public/config-form.html exists.'));
      }
      
      const stylesDir = path.join(dashboardDir, '../src/styles');
      
      this.server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${this.config.port}`);
        const pathname = parsedUrl.pathname;
        
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        
        // API endpoint for form submission
        if (pathname === '/api/config' && req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            try {
              const config = JSON.parse(body);
              Logger.info('ConfigUILauncher', 'Received configuration from user');
              
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'Configuration received' }));
              
              // Resolve the promise with the config
              if (this.resolveConfig) {
                this.cleanup();
                this.resolveConfig(config);
              }
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
            }
          });
          return;
        }
        
        // Serve static files
        let filePath;
        if (pathname.startsWith('/src/styles/')) {
          filePath = path.join(stylesDir, pathname.replace('/src/styles/', ''));
        } else if (pathname === '/' || pathname === '/config-form.html') {
          filePath = path.join(dashboardDir, 'config-form.html');
        } else {
          filePath = path.join(dashboardDir, pathname);
        }
        
        // Security check
        if (!filePath.startsWith(dashboardDir) && !filePath.startsWith(stylesDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        
        // Get content type
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
          '.html': 'text/html',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
        };
        
        const contentType = contentTypes[ext] || 'text/plain';
        
        fs.readFile(filePath, (err, data) => {
          if (err) {
            if (err.code === 'ENOENT') {
              res.writeHead(404);
              res.end('File not found');
            } else {
              res.writeHead(500);
              res.end('Server error');
            }
            return;
          }
          
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(data);
        });
      });
      
      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          // Try next port
          this.config.port++;
          Logger.debug('ConfigUILauncher', `Port in use, trying next port`, { port: this.config.port });
          this.startServer(projectInfo).then(resolve).catch(reject);
        } else {
          reject(error);
        }
      });
      
      this.server.listen(this.config.port, () => {
        resolve();
      });
    });
  }

  /**
   * Cleanup server
   */
  cleanup() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.resolveConfig = null;
    this.rejectConfig = null;
  }

  /**
   * Cancel and cleanup
   */
  cancel() {
    if (this.rejectConfig) {
      this.rejectConfig(new Error('Configuration cancelled'));
    }
    this.cleanup();
  }
}

module.exports = ConfigUILauncher;
