/**
 * Auto-Detector
 * Automatically detects project settings from files and configuration
 */

const fs = require('fs');
const path = require('path');

class AutoDetector {
  /**
   * Detect project settings from the given path
   * @param {string} projectPath - Path to the project root
   * @returns {Object} Detected settings
   */
  async detect(projectPath) {
    const resolvedPath = path.resolve(projectPath);

    // Read various config files
    const packageJson = this.readPackageJson(resolvedPath);
    const playwrightConfig = this.readPlaywrightConfig(resolvedPath);
    const envFile = this.readEnvFile(resolvedPath);

    // Detect settings
    const projectName = packageJson?.name || path.basename(resolvedPath);
    const port = this.detectPort(packageJson, envFile, playwrightConfig);
    const baseURL = this.detectBaseURL(packageJson, envFile, playwrightConfig, port);
    const startCommand = this.detectStartCommand(packageJson);
    const testDirs = this.scanTestDirs(resolvedPath);

    return {
      projectPath: resolvedPath,
      projectName,
      port,
      baseURL,
      startCommand,
      hasPlaywright: !!playwrightConfig,
      hasJira: this.detectJiraConfig(envFile),
      testDirs,
      packageJson,
      playwrightConfig,
    };
  }

  /**
   * Read package.json
   */
  readPackageJson(projectPath) {
    const packagePath = path.join(projectPath, 'package.json');
    try {
      if (fs.existsSync(packagePath)) {
        return JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      }
    } catch (error) {
      console.error(`Failed to read package.json: ${error.message}`);
    }
    return null;
  }

  /**
   * Read playwright.config.js
   */
  readPlaywrightConfig(projectPath) {
    const configPaths = [
      path.join(projectPath, 'playwright.config.js'),
      path.join(projectPath, 'playwright.config.ts'),
    ];

    for (const configPath of configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          // Read file content to extract basic settings
          const content = fs.readFileSync(configPath, 'utf-8');
          return this.parsePlaywrightConfig(content);
        }
      } catch (error) {
        console.error(`Failed to read playwright config: ${error.message}`);
      }
    }
    return null;
  }

  /**
   * Parse playwright config from file content
   */
  parsePlaywrightConfig(content) {
    const config = {};

    // Extract baseURL
    const baseURLMatch = content.match(/baseURL:\s*['"`]([^'"`]+)['"`]/);
    if (baseURLMatch) {
      config.baseURL = baseURLMatch[1];
    }

    // Extract from env variable reference
    const envBaseURLMatch = content.match(/baseURL:\s*process\.env\.([A-Z_]+)/);
    if (envBaseURLMatch) {
      config.baseURLEnvVar = envBaseURLMatch[1];
    }

    // Extract testDir
    const testDirMatch = content.match(/testDir:\s*['"`]([^'"`]+)['"`]/);
    if (testDirMatch) {
      config.testDir = testDirMatch[1];
    }

    // Extract projects
    const projectsMatch = content.match(/projects:\s*\[([^\]]+)\]/s);
    if (projectsMatch) {
      config.hasProjects = true;
    }

    return config;
  }

  /**
   * Read .env file
   */
  readEnvFile(projectPath) {
    const envPath = path.join(projectPath, '.env');
    try {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const env = {};
        content.split('\n').forEach((line) => {
          const match = line.match(/^([A-Z_]+)=(.*)$/);
          if (match) {
            env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
          }
        });
        return env;
      }
    } catch (error) {
      console.error(`Failed to read .env: ${error.message}`);
    }
    return null;
  }

  /**
   * Detect port number
   */
  detectPort(packageJson, envFile, playwrightConfig) {
    // Check env file first
    if (envFile) {
      if (envFile.PORT) return parseInt(envFile.PORT, 10);
      if (envFile.APP_PORT) return parseInt(envFile.APP_PORT, 10);
    }

    // Check playwright config baseURL
    if (playwrightConfig?.baseURL) {
      const match = playwrightConfig.baseURL.match(/:(\d+)/);
      if (match) return parseInt(match[1], 10);
    }

    // Check package.json scripts for port hints
    if (packageJson?.scripts) {
      const scripts = JSON.stringify(packageJson.scripts);
      const portMatch = scripts.match(/--port[=\s](\d+)|PORT=(\d+)/);
      if (portMatch) {
        return parseInt(portMatch[1] || portMatch[2], 10);
      }
    }

    // Common defaults
    if (packageJson?.dependencies) {
      if (packageJson.dependencies.vite) return 5173;
      if (packageJson.dependencies.next) return 3000;
      if (packageJson.dependencies['create-react-app']) return 3000;
      if (packageJson.dependencies.express) return 3000;
    }

    return 8000; // Default fallback
  }

  /**
   * Detect base URL
   */
  detectBaseURL(packageJson, envFile, playwrightConfig, port) {
    // Check env file
    if (envFile) {
      if (envFile.BASE_URL) return envFile.BASE_URL;
      if (envFile.APP_URL) return envFile.APP_URL;
    }

    // Check playwright config
    if (playwrightConfig?.baseURL && !playwrightConfig.baseURL.includes('process.env')) {
      return playwrightConfig.baseURL;
    }

    // Construct from port
    return `http://localhost:${port}`;
  }

  /**
   * Detect start command
   */
  detectStartCommand(packageJson) {
    if (!packageJson?.scripts) return null;

    const scripts = packageJson.scripts;

    // Priority order for start commands
    const startScripts = ['dev', 'start', 'serve', 'start:dev', 'develop'];

    for (const script of startScripts) {
      if (scripts[script]) {
        return `npm run ${script}`;
      }
    }

    return null;
  }

  /**
   * Detect Jira configuration
   */
  detectJiraConfig(envFile) {
    if (!envFile) return false;

    return !!(
      envFile.JIRA_BASE_URL ||
      envFile.JIRA_API_TOKEN ||
      envFile.JIRA_PROJECT_KEY
    );
  }

  /**
   * Scan for test directories
   */
  scanTestDirs(projectPath) {
    const testDirs = [];
    const possibleDirs = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e'];

    for (const dir of possibleDirs) {
      const fullPath = path.join(projectPath, dir);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        testDirs.push(dir);

        // Check for subdirectories
        const subDirs = ['frontend', 'backend', 'api', 'e2e', 'unit', 'integration'];
        for (const subDir of subDirs) {
          const subPath = path.join(fullPath, subDir);
          if (fs.existsSync(subPath) && fs.statSync(subPath).isDirectory()) {
            testDirs.push(`${dir}/${subDir}`);
          }
        }
      }
    }

    return testDirs;
  }
}

module.exports = AutoDetector;
