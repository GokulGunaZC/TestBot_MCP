// Data Parser for Playwright Test Results
class TestDataParser {
    constructor() {
        this.testData = null;
        this.aiAnalysisData = null;
        this.attachmentsManifest = null;
        this.suites = new Map();
        this.tests = [];
        this.categoryStats = new Map();
        this.baselineData = {
            branch: 'main',
            passRate: 100,
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0
        };
        this.comparisonData = null;
        this.resetAggregates();
    }

    resetAggregates() {
        this.stats = {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            timedout: 0,
            duration: 0,
            startTime: null,
            endTime: null,
            passRate: 0,
            failRate: 0,
            avgDuration: 0
        };
        this.suites = new Map();
        this.tests = [];
        this.categoryStats = new Map();
        // Don't reset aiAnalysisData here - it should persist after loading
    }

    /**
     * Load test data from JSON file
     * Supports both Testbot report format and legacy Playwright JSON format
     * 
     * Loading priority:
     * 1. Embedded data (window.__TESTBOT_EMBEDDED_REPORT__) - works with file:// protocol
     * 2. Fetch from report.json - works with http:// protocol
     * 3. Mock data fallback - for demonstration
     */
    async loadData(jsonPath = 'report.json') {
        try {
            console.log('🔄 Dashboard: Attempting to load test data...');
            
            // Check for embedded report data first (bypasses CORS for file:// protocol)
            if (window.__TESTBOT_EMBEDDED_REPORT__) {
                console.log('✅ Dashboard: Found embedded report data (file:// mode)');
                const data = window.__TESTBOT_EMBEDDED_REPORT__;
                
                // Clear any previous data before loading new
                this.testData = null;
                this.aiAnalysisData = null;
                this.attachmentsManifest = null;
                this.resetAggregates();
                
                console.log('📊 Dashboard: Using embedded data:');
                console.log(`   Project: ${data.metadata?.projectName || 'Unknown'}`);
                console.log(`   Tests: ${data.stats?.total || 0} total`);
                console.log(`   Passed: ${data.stats?.passed || 0}`);
                console.log(`   Failed: ${data.stats?.failed || 0}`);
                console.log(`   Timestamp: ${data.metadata?.timestamp || 'N/A'}`);
                
                // Check for empty report
                if (data.stats?.total === 0) {
                    console.warn('⚠️ Dashboard: Embedded report contains 0 tests!');
                }
                
                // Process the embedded data
                if (data.metadata && data.stats && data.tests) {
                    this.testData = this.convertFromTestbotFormat(data);
                    this.aiAnalysisData = this.extractAIAnalysisFromTestbot(data);
                    this.parseData();
                    console.log('✅ Dashboard: Embedded data parsed successfully');
                    return this.testData;
                }
                
                // Legacy format
                this.testData = data;
                this.parseData();
                return this.testData;
            }
            
            console.log('📂 Dashboard: No embedded data, trying fetch from:', jsonPath);
            
            // Add timestamp to prevent browser caching
            const timestamp = new Date().getTime();
            const cacheBustedPath = jsonPath.includes('?') 
                ? `${jsonPath}&_t=${timestamp}` 
                : `${jsonPath}?_t=${timestamp}`;
            
            console.log(`🚫 Dashboard: Cache-busted URL: ${cacheBustedPath}`);
            
            const response = await fetch(cacheBustedPath, {
                cache: 'no-store',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            });
            
            if (!response.ok) {
                console.error(`❌ Dashboard: HTTP error! Status: ${response.status} ${response.statusText}`);
                console.error('❌ Dashboard: Make sure report.json exists in the dashboard/public folder');
                throw new Error(`Failed to load test data: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            // Clear any previous data before loading new
            this.testData = null;
            this.aiAnalysisData = null;
            this.attachmentsManifest = null;
            this.resetAggregates();
            
            // Enhanced logging for debugging
            console.log('📊 Dashboard: Successfully loaded test data:');
            console.log(`   Project: ${data.metadata?.projectName || 'Unknown'}`);
            console.log(`   Tests: ${data.stats?.total || 0} total`);
            console.log(`   Passed: ${data.stats?.passed || 0}`);
            console.log(`   Failed: ${data.stats?.failed || 0}`);
            console.log(`   Timestamp: ${data.metadata?.timestamp || 'N/A'}`);
            
            // Check for stale data
            if (data.metadata?.timestamp) {
                const reportTime = new Date(data.metadata.timestamp);
                const now = new Date();
                const ageMinutes = Math.floor((now - reportTime) / (1000 * 60));
                const ageHours = Math.floor(ageMinutes / 60);
                
                if (ageHours >= 24) {
                    console.warn(`⚠️ Dashboard: Report is ${Math.floor(ageHours / 24)} days old!`);
                    console.warn('⚠️ Dashboard: Run TestBot again to generate fresh results');
                } else if (ageHours >= 1) {
                    console.log(`ℹ️ Dashboard: Report is ${ageHours} hours old`);
                } else if (ageMinutes > 5) {
                    console.log(`ℹ️ Dashboard: Report is ${ageMinutes} minutes old`);
                } else {
                    console.log(`✅ Dashboard: Report is fresh (${ageMinutes} minutes old)`);
                }
            }
            
            // Check for empty report (common issue)
            if (data.stats?.total === 0) {
                console.error('⚠️ Dashboard: WARNING - Report contains 0 tests!');
                console.error('⚠️ Dashboard: This usually means:');
                console.error('   1. Playwright config is missing: reporter: [[\'json\', { outputFile: \'test-results.json\' }]]');
                console.error('   2. Tests failed to run');
                console.error('   3. test-results.json was not found by TestBot');
                console.error('⚠️ Dashboard: Run: node scripts/debug-dashboard.js for detailed diagnostics');
            }
            
            // Check if this is a Testbot report format
            if (data.metadata && data.stats && data.tests) {
                this.testData = this.convertFromTestbotFormat(data);
                this.aiAnalysisData = this.extractAIAnalysisFromTestbot(data);
                this.parseData();
                console.log('✅ Dashboard: Data parsing complete');
                return this.testData;
            }
            
            // Legacy Playwright format
            this.testData = data;
            
            // Try to load AI analysis data
            await this.loadAIAnalysis();
            
            // Try to load attachments manifest
            await this.loadAttachmentsManifest();
            
            this.parseData();
            console.log('✅ Dashboard: Data parsing complete (legacy format)');
            return this.testData;
        } catch (error) {
            console.error('❌ Dashboard: Error loading test data:', error);
            
            // Check if this is a CORS error (common with file:// protocol)
            if (error.message?.includes('fetch') || error.name === 'TypeError') {
                console.error('❌ Dashboard: This appears to be a CORS/fetch error.');
                console.error('❌ Dashboard: This happens when opening via file:// protocol.');
                console.error('❌ Dashboard: Solutions:');
                console.error('   1. Run TestBot again - it will embed the data directly');
                console.error('   2. Or use a local server: cd dashboard/public && python3 -m http.server 8080');
                console.error('   3. Or run: ./scripts/fix-dashboard-now.sh');
            } else {
                console.error('❌ Dashboard: Troubleshooting steps:');
                console.error('   1. Check that dashboard/public/report.json exists');
                console.error('   2. Verify the JSON is valid (try opening it in a text editor)');
                console.error('   3. Run TestBot to generate a new report');
            }
            console.error('   Run: node scripts/debug-dashboard.js for detailed diagnostics');
            
            // Return mock data for demonstration if file doesn't exist
            console.warn('⚠️ Dashboard: Loading mock data for demonstration...');
            return this.generateMockData();
        }
    }
    
    /**
     * Convert Testbot report format to internal format
     */
    convertFromTestbotFormat(report) {
        // Store project name for display
        this.projectName = report.metadata?.projectName || 'Test Project';
        
        // Convert tests to suites structure
        const suiteMap = new Map();
        
        for (const test of report.tests || []) {
            const suiteName = test.suite || 'Default Suite';
            if (!suiteMap.has(suiteName)) {
                suiteMap.set(suiteName, {
                    title: suiteName,
                    specs: [],
                    suites: []
                });
            }
            
            const suite = suiteMap.get(suiteName);
            suite.specs.push({
                title: test.title,
                file: test.file,
                tests: [{
                    status: test.status === 'passed' ? 'expected' : 
                           test.status === 'failed' ? 'unexpected' : test.status,
                    results: [{
                        status: test.status,
                        duration: test.duration,
                        error: test.error,
                        attachments: this.convertAttachments(test.attachments)
                    }],
                    projectName: test.category || 'Other'
                }]
            });
        }
        
        return {
            suites: Array.from(suiteMap.values()),
            config: {
                metadata: {
                    actualStartTime: report.metadata?.timestamp
                }
            }
        };
    }
    
    /**
     * Convert Testbot attachments to Playwright format
     */
    convertAttachments(attachments) {
        if (!attachments) return [];
        
        const result = [];
        
        for (const screenshot of attachments.screenshots || []) {
            result.push({
                name: screenshot.name,
                contentType: 'image/png',
                path: screenshot.path
            });
        }
        
        for (const video of attachments.videos || []) {
            result.push({
                name: video.name,
                contentType: 'video/webm',
                path: video.path
            });
        }
        
        for (const trace of attachments.traces || []) {
            result.push({
                name: trace.name,
                contentType: 'application/zip',
                path: trace.path
            });
        }
        
        return result;
    }
    
    /**
     * Extract AI analysis from Testbot report
     */
    extractAIAnalysisFromTestbot(report) {
        const analyses = {};
        
        for (const test of report.tests || []) {
            if (test.aiAnalysis) {
                const testId = `${test.file}-${test.title}`.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');
                analyses[testId] = {
                    testName: test.title,
                    file: test.file,
                    status: test.status,
                    error: test.error,
                    aiAnalysis: test.aiAnalysis
                };
            }
        }
        
        return {
            analyses,
            aiProvider: 'testbot',
            model: 'sarvam-m'
        };
    }

    /**
     * Load AI analysis data if available
     */
    async loadAttachmentsManifest(jsonPath = 'attachments-manifest.json') {
        try {
            const response = await fetch(jsonPath);
            if (!response.ok) {
                console.log('No attachments manifest found (this is normal if no tests failed)');
                return;
            }
            this.attachmentsManifest = await response.json();
            console.log('✅ Loaded attachments manifest');
        } catch (error) {
            console.log('No attachments manifest available');
        }
    }

    async loadAIAnalysis() {
        try {
            const response = await fetch('ai-analysis.json');
            if (response.ok) {
                this.aiAnalysisData = await response.json();
                console.log('✅ Loaded AI analysis data:', Object.keys(this.aiAnalysisData.analyses || {}).length, 'analyses');
            } else {
                console.log('ℹ️  AI analysis file not found (status:', response.status, ')');
                this.aiAnalysisData = null;
            }
        } catch (error) {
            console.log('ℹ️  No AI analysis data available:', error.message);
            this.aiAnalysisData = null;
        }
    }

    /**
     * Parse the loaded test data
     */
    parseData() {
        if (!this.testData || !this.testData.suites) {
            console.warn('No test data available to parse');
            return;
        }

        this.resetAggregates();
        this.stats.startTime = new Date(this.testData.config?.metadata?.actualStartTime || Date.now());
        
        // Parse all test suites
        this.testData.suites.forEach(suite => {
            this.parseSuite(suite);
        });

        // Calculate total duration
        this.stats.duration = this.tests.reduce((sum, test) => sum + (test.duration || 0), 0);
        this.stats.endTime = new Date(this.stats.startTime.getTime() + this.stats.duration);
    }

    /**
     * Parse a test suite recursively
     */
    parseSuite(suite, parentSuiteName = '') {
        // Build suite name - extract from file path for jira-generated tests
        let suiteName = parentSuiteName 
            ? `${parentSuiteName} › ${suite.title}` 
            : suite.title;
        
        // For jira-generated tests, extract story key from file path
        if (suite.file && suite.file.includes('jira-generated')) {
            const match = suite.file.match(/mscship[_-]?(\d+)/i);
            if (match) {
                suiteName = `MSCSHIP-${match[1]}`;
            }
        }

        // Initialize suite stats if not exists
        if (!this.suites.has(suiteName)) {
            this.suites.set(suiteName, {
                name: suiteName,
                total: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                duration: 0
            });
        }

        const suiteStats = this.suites.get(suiteName);

        // Parse tests in this suite
        if (suite.specs && suite.specs.length > 0) {
            suite.specs.forEach(spec => {
                this.parseSpec(spec, suiteName, suiteStats);
            });
        }

        // Parse nested suites
        if (suite.suites && suite.suites.length > 0) {
            suite.suites.forEach(nestedSuite => {
                this.parseSuite(nestedSuite, suiteName);
            });
        }
    }

    /**
     * Parse individual test spec
     */
    parseSpec(spec, suiteName, suiteStats) {
        // Get test results from all attempts
        const tests = spec.tests || [];
        
        tests.forEach(test => {
            const results = test.results || [];
            const lastResult = results[results.length - 1];
            
            if (!lastResult) return;

            const status = lastResult.status || 'unknown';
            const normalizedStatus = TestDataParser.normalizeStatus(status);
            const duration = lastResult.duration || 0;
            const error = lastResult.error;
            const category = this.getCategoryFromTest(test, spec.file);
            // Parse attachments from JSON (usually empty) and supplement with folder scan
            const attachments = this.parseAttachments(lastResult.attachments || [], spec.file, normalizedStatus);

            // Create test object
            const testObj = {
                id: `${suiteName}-${spec.title}-${test.title || spec.title}`.replace(/\s+/g, '-'),
                title: test.title || spec.title,
                fullTitle: `${suiteName} › ${test.title || spec.title}`,
                suite: suiteName,
                category,
                status: normalizedStatus,
                duration: duration,
                error: error ? {
                    message: error.message || '',
                    stack: error.stack || ''
                } : null,
                retries: results.length - 1,
                file: spec.file || '',
                attachments: attachments,
                aiAnalysis: null
            };
            
            // Merge AI analysis if available for this test
            this.mergeAIAnalysis(testObj);

            // Update statistics
            this.stats.total++;
            suiteStats.total++;
            suiteStats.duration += duration;

            switch (normalizedStatus) {
                case 'passed':
                case 'expected':
                    this.stats.passed++;
                    suiteStats.passed++;
                    break;
                case 'failed':
                case 'unexpected':
                    this.stats.failed++;
                    suiteStats.failed++;
                    break;
                case 'skipped':
                    this.stats.skipped++;
                    suiteStats.skipped++;
                    break;
                case 'pending':
                    this.stats.skipped++;
                    suiteStats.skipped++;
                    break;
                case 'timedout':
                    this.stats.timedout++;
                    suiteStats.timedout = (suiteStats.timedout || 0) + 1;
                    break;
                default:
                    break;
            }

            this.updateCategoryStats(category, normalizedStatus, duration);

            this.tests.push(testObj);
        });
    }

    /**
     * Merge AI analysis data with test object
     */
    mergeAIAnalysis(testObj) {
        if (!this.aiAnalysisData || !this.aiAnalysisData.analyses) {
            return;
        }

        // Try multiple matching strategies
        // Strategy 1: Exact match using file-title ID
        const testId1 = `${testObj.file}-${testObj.title}`.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '');
        
        // Strategy 2: Match by file and title separately (more flexible)
        let matchedAnalysis = this.aiAnalysisData.analyses[testId1];
        
        if (!matchedAnalysis) {
            // Try to find by matching file path and test name
            for (const [key, analysis] of Object.entries(this.aiAnalysisData.analyses)) {
                // Normalize paths for comparison (handle forward/backward slashes)
                const normalizedTestFile = testObj.file.replace(/\\/g, '/').toLowerCase();
                const normalizedAnalysisFile = analysis.file.replace(/\\/g, '/').toLowerCase();
                const normalizedTestTitle = testObj.title.toLowerCase().trim();
                const normalizedAnalysisTitle = analysis.testName.toLowerCase().trim();
                
                // Check if file paths end with the same relative path
                if (normalizedTestFile.endsWith(normalizedAnalysisFile) || 
                    normalizedAnalysisFile.endsWith(normalizedTestFile)) {
                    // Check if test names match
                    if (normalizedTestTitle === normalizedAnalysisTitle) {
                        matchedAnalysis = analysis;
                        break;
                    }
                }
            }
        }
        
        if (matchedAnalysis && matchedAnalysis.aiAnalysis) {
            testObj.aiAnalysis = {
                analysis: matchedAnalysis.aiAnalysis.analysis || '',
                rootCause: matchedAnalysis.aiAnalysis.rootCause || '',
                confidence: matchedAnalysis.aiAnalysis.confidence || 0,
                suggestedFix: matchedAnalysis.aiAnalysis.suggestedFix || null,
                affectedFiles: matchedAnalysis.aiAnalysis.affectedFiles || [],
                testingRecommendations: matchedAnalysis.aiAnalysis.testingRecommendations || '',
                aiProvider: this.aiAnalysisData.aiProvider || 'AI',
                model: this.aiAnalysisData.model || 'Unknown'
            };
        }
    }

    getCategoryFromTest(test, filePath) {
        // Check for smoke test tags or annotations
        if (test && test.tags) {
            const tags = Array.isArray(test.tags) ? test.tags : [test.tags];
            if (tags.some(tag => tag.toLowerCase().includes('smoke'))) {
                return 'Smoke';
            }
        }
        
        // Check test title for smoke indicator
        if (test && test.title && test.title.toLowerCase().includes('@smoke')) {
            return 'Smoke';
        }
        
        // First try to get category from projectName metadata
        if (test && test.projectName) {
            const projectName = test.projectName.toLowerCase();
            if (projectName === 'smoke') {
                return 'Smoke';
            }
            if (projectName === 'frontend') {
                return 'Frontend';
            }
            if (projectName === 'backend') {
                return 'Backend';
            }
        }
        
        // Fallback to file path detection
        if (!filePath) {
            return 'Other';
        }
        const normalized = filePath.replace(/\\/g, '/').toLowerCase();
        if (normalized.includes('smoke')) {
            return 'Smoke';
        }
        if (normalized.includes('frontend')) {
            return 'Frontend';
        }
        if (normalized.includes('backend')) {
            return 'Backend';
        }
        return 'Other';
    }

    parseAttachments(attachments, testFile, testStatus) {
        const parsed = {
            screenshots: [],
            videos: [],
            traces: [],
            other: []
        };
        
        // If attachments array is provided and not empty, parse it
        if (attachments && Array.isArray(attachments) && attachments.length > 0) {

            attachments.forEach(attachment => {
                const { name, contentType, path } = attachment;
                
                if (!path) return;

                // Convert absolute path to relative path for web access
                const relativePath = this.convertToRelativePath(path);
                
                const attachmentObj = {
                    name: name || 'Unnamed',
                    contentType: contentType || 'application/octet-stream',
                    path: relativePath,
                    originalPath: path
                };

                // Categorize by content type
                if (contentType && contentType.startsWith('image/')) {
                    parsed.screenshots.push(attachmentObj);
                } else if (contentType && contentType.startsWith('video/')) {
                    parsed.videos.push(attachmentObj);
                } else if (name && (name.includes('trace') || contentType === 'application/zip')) {
                    parsed.traces.push(attachmentObj);
                } else {
                    parsed.other.push(attachmentObj);
                }
            });
        } else if (testFile && this.attachmentsManifest) {
            // Check if we have attachments in the manifest for this test file
            const normalizedTestFile = testFile.replace(/\\/g, '/');
            const manifestEntry = this.attachmentsManifest[normalizedTestFile];
            
            if (manifestEntry) {
                // Merge manifest attachments into parsed
                if (manifestEntry.screenshots) {
                    parsed.screenshots.push(...manifestEntry.screenshots);
                }
                if (manifestEntry.videos) {
                    parsed.videos.push(...manifestEntry.videos);
                }
                if (manifestEntry.traces) {
                    parsed.traces.push(...manifestEntry.traces);
                }
                if (manifestEntry.other) {
                    parsed.other.push(...manifestEntry.other);
                }
            }
        }

        return parsed;
    }

    convertToRelativePath(absolutePath) {
        if (!absolutePath) return '';
        
        // Convert Windows backslashes to forward slashes
        let normalized = absolutePath.replace(/\\/g, '/');
        
        // Extract just the filename from test-results directory
        // Paths look like: C:/Users/.../test-results/mscship_XX-...-screenshot-1.png
        const testResultsMatch = normalized.match(/test-results\/(.+)$/);
        if (testResultsMatch) {
            // Return relative path from dashboard location
            // Dashboard is in custom-report/, test-results/ is at same level
            return `../test-results/${testResultsMatch[1]}`;
        }
        
        // Try alternative pattern with backslashes
        const testResultsMatch2 = normalized.match(/test-results[\/\\](.+)$/);
        if (testResultsMatch2) {
            return `../test-results/${testResultsMatch2[1]}`;
        }
        
        // Last resort: return the path as-is
        return normalized;
    }

    updateCategoryStats(category, status, duration) {
        if (!this.categoryStats.has(category)) {
            this.categoryStats.set(category, {
                name: category,
                total: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                timedout: 0,
                duration: 0
            });
        }
        const entry = this.categoryStats.get(category);
        entry.total++;
        entry.duration += duration;

        switch (status) {
            case 'passed':
            case 'expected':
                entry.passed++;
                break;
            case 'failed':
            case 'unexpected':
                entry.failed++;
                break;
            case 'skipped':
            case 'pending':
                entry.skipped++;
                break;
            case 'timedout':
                entry.timedout++;
                break;
            default:
                break;
        }
    }

    createEmptyCategoryStat(name = 'Category') {
        return {
            name,
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            timedout: 0,
            duration: 0
        };
    }

    getCategoryStat(categoryName) {
        if (!categoryName) {
            return this.createEmptyCategoryStat('Unknown');
        }
        const normalized = categoryName.toLowerCase();
        for (const [key, value] of this.categoryStats.entries()) {
            if (key.toLowerCase() === normalized) {
                return value;
            }
        }
        const formattedName = categoryName.charAt(0).toUpperCase() + categoryName.slice(1);
        return this.createEmptyCategoryStat(formattedName);
    }

    getScopeStats(scope = 'all') {
        const normalizedScope = (scope || 'all').toLowerCase();
        if (normalizedScope === 'all') {
            return this.getStats();
        }

        const categoryName = TestDataParser.scopeToCategory(normalizedScope);
        const categoryStats = { ...this.getCategoryStat(categoryName) };
        const baseTotal = categoryStats.total || 0;
        const passRate = baseTotal > 0 ? Math.round((categoryStats.passed / baseTotal) * 100) : 0;
        const failRate = baseTotal > 0 ? Math.round((categoryStats.failed / baseTotal) * 100) : 0;
        const avgDuration = baseTotal > 0 ? Math.round((categoryStats.duration || 0) / baseTotal) : 0;

        return {
            ...categoryStats,
            passRate,
            failRate,
            avgDuration,
            startTime: this.stats.startTime,
            endTime: this.stats.endTime,
            duration: categoryStats.duration || 0
        };
    }

    getTestsByScope(scope = 'all') {
        const normalizedScope = (scope || 'all').toLowerCase();
        if (normalizedScope === 'all') {
            return this.tests;
        }
        const categoryName = TestDataParser.scopeToCategory(normalizedScope).toLowerCase();
        return this.tests.filter(test => (test.category || 'Other').toLowerCase() === categoryName);
    }

    getSuiteStatsByScope(scope = 'all') {
        const normalizedScope = (scope || 'all').toLowerCase();
        if (normalizedScope === 'all') {
            return this.getSuiteStats();
        }

        const scopedTests = this.getTestsByScope(normalizedScope);
        const suiteMap = new Map();

        scopedTests.forEach(test => {
            const suiteName = test.suite || 'Unnamed Suite';
            if (!suiteMap.has(suiteName)) {
                suiteMap.set(suiteName, {
                    name: suiteName,
                    total: 0,
                    passed: 0,
                    failed: 0,
                    skipped: 0,
                    duration: 0
                });
            }

            const suiteStats = suiteMap.get(suiteName);
            suiteStats.total++;
            suiteStats.duration += test.duration || 0;

            switch (TestDataParser.normalizeStatus(test.status)) {
                case 'passed':
                    suiteStats.passed++;
                    break;
                case 'failed':
                    suiteStats.failed++;
                    break;
                case 'skipped':
                    suiteStats.skipped++;
                    break;
                default:
                    break;
            }
        });

        return Array.from(suiteMap.values());
    }

    /**
     * Generate mock data for demonstration
     */
    generateMockData() {
        console.log('Generating mock data for demonstration...');
        this.resetAggregates();
        
        this.stats = {
            total: 21,
            passed: 21,
            failed: 0,
            skipped: 0,
            duration: 5823,
            startTime: new Date(Date.now() - 5823),
            endTime: new Date()
        };

        // Mock test suites
        const suites = [
            { name: 'Home Page Tests', passed: 5, failed: 0, skipped: 0 },
            { name: 'Login Page Tests', passed: 4, failed: 0, skipped: 0 },
            { name: 'Register Page Tests', passed: 4, failed: 0, skipped: 0 },
            { name: 'Cruises Page Tests', passed: 5, failed: 0, skipped: 0 },
            { name: 'Contact Page Tests', passed: 3, failed: 0, skipped: 0 }
        ];

        suites.forEach(suite => {
            this.suites.set(suite.name, {
                name: suite.name,
                total: suite.passed + suite.failed + suite.skipped,
                passed: suite.passed,
                failed: suite.failed,
                skipped: suite.skipped,
                duration: Math.floor(Math.random() * 2000) + 500
            });
        });

        // Mock tests
        const testNames = [
            ['should load home page successfully', 'should display navigation elements', 'should display cruise listings', 'should have login link', 'should have register link'],
            ['should load login page successfully', 'should display login form elements', 'should show error message for invalid credentials', 'should navigate to register page'],
            ['should load register page successfully', 'should display registration form elements', 'should validate required fields', 'should navigate to login page'],
            ['should load cruises page successfully', 'should display cruise listings', 'should have search/filter functionality', 'should display cruise cards with details', 'should allow viewing cruise details'],
            ['should load contact page successfully', 'should display contact form elements', 'should validate contact form fields']
        ];

        suites.forEach((suite, index) => {
            const categoryFolder = index < 3 ? 'frontend' : 'backend';
            const categoryName = categoryFolder === 'frontend' ? 'Frontend' : 'Backend';

            testNames[index].forEach(testName => {
                const duration = Math.floor(Math.random() * 1000) + 100;
                this.tests.push({
                    id: `${suite.name}-${testName}`.replace(/\s+/g, '-'),
                    title: testName,
                    fullTitle: `${suite.name} › ${testName}`,
                    suite: suite.name,
                    status: 'passed',
                    duration,
                    error: null,
                    retries: 0,
                    file: `tests/${categoryFolder}/${suite.name.toLowerCase().replace(/\s+/g, '-')}.spec.js`
                });
                this.updateCategoryStats(categoryName, 'passed', duration);
            });
        });

        return this.testData;
    }

    /**
     * Get statistics summary
     */
    getStats() {
        return {
            ...this.stats,
            passRate: this.stats.total > 0 
                ? Math.round((this.stats.passed / this.stats.total) * 100) 
                : 0,
            failRate: this.stats.total > 0 
                ? Math.round((this.stats.failed / this.stats.total) * 100) 
                : 0,
            avgDuration: this.stats.total > 0 
                ? Math.round(this.stats.duration / this.stats.total) 
                : 0
        };
    }

    /**
     * Get suite statistics
     */
    getSuiteStats() {
        return Array.from(this.suites.values());
    }

    /**
     * Get category statistics
     */
    getCategoryStats() {
        return Array.from(this.categoryStats.values());
    }

    /**
     * Get all tests
     */
    getTests() {
        return this.tests;
    }

    /**
     * Get tests filtered by status
     */
    getTestsByStatus(status) {
        if (status === 'all') {
            return this.tests;
        }
        return this.tests.filter(test => test.status === status);
    }

    /**
     * Search tests by title or suite name
     */
    searchTests(query) {
        if (!query) return this.tests;
        
        const lowerQuery = query.toLowerCase();
        return this.tests.filter(test => 
            test.title.toLowerCase().includes(lowerQuery) ||
            test.suite.toLowerCase().includes(lowerQuery)
        );
    }

    /**
     * Format duration to human-readable string
     */
    static formatDuration(ms) {
        if (ms < 1000) {
            return `${ms}ms`;
        } else if (ms < 60000) {
            return `${(ms / 1000).toFixed(2)}s`;
        } else {
            const minutes = Math.floor(ms / 60000);
            const seconds = ((ms % 60000) / 1000).toFixed(0);
            return `${minutes}m ${seconds}s`;
        }
    }

    /**
     * Format timestamp to human-readable string
     */
    static formatTimestamp(date) {
        if (!date) return 'N/A';
        
        const d = new Date(date);
        return d.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    /**
     * Get status icon
     */
    static getStatusIcon(status) {
        switch (status) {
            case 'passed':
            case 'expected':
                return '<i class="fas fa-check-circle"></i>';
            case 'failed':
            case 'unexpected':
                return '<i class="fas fa-times-circle"></i>';
            case 'skipped':
            case 'pending':
                return '<i class="fas fa-forward"></i>';
            default:
                return '<i class="fas fa-question-circle"></i>';
        }
    }

    static normalizeStatus(status) {
        if (!status) return 'unknown';
        const normalized = status.toLowerCase();
        if (normalized === 'expected') return 'passed';
        if (normalized === 'unexpected') return 'failed';
        if (normalized === 'pending') return 'skipped';
        return normalized;
    }

    static scopeToCategory(scope) {
        switch ((scope || '').toLowerCase()) {
            case 'frontend':
                return 'Frontend';
            case 'backend':
                return 'Backend';
            case 'smoke':
                return 'Smoke';
            default:
                return 'Other';
        }
    }

    /**
     * Calculate regression comparison with baseline
     */
    calculateRegressionComparison() {
        const currentStats = this.getStats();
        
        // Set baseline total to match current for demo
        this.baselineData.total = currentStats.total;
        this.baselineData.passed = currentStats.total;
        this.baselineData.failed = 0;
        this.baselineData.skipped = 0;
        
        const currentPassRate = currentStats.passRate;
        const baselinePassRate = this.baselineData.passRate;
        const difference = currentPassRate - baselinePassRate;
        const percentChange = baselinePassRate > 0 ? ((difference / baselinePassRate) * 100) : 0;
        
        // Calculate test changes
        const newFailures = currentStats.failed;
        const fixedTests = 0; // Since baseline is 100%, any passing test was already passing
        const newTests = 0; // Assuming same test count
        
        // Calculate suite-wise comparisons
        const suiteComparisons = this.calculateSuiteWiseComparison();
        
        this.comparisonData = {
            baseline: {
                branch: this.baselineData.branch,
                passRate: baselinePassRate,
                total: this.baselineData.total,
                passed: this.baselineData.passed,
                failed: this.baselineData.failed,
                skipped: this.baselineData.skipped
            },
            current: {
                branch: 'current',
                passRate: currentPassRate,
                total: currentStats.total,
                passed: currentStats.passed,
                failed: currentStats.failed,
                skipped: currentStats.skipped
            },
            comparison: {
                passRateDifference: difference,
                percentChange: percentChange,
                trend: difference >= 0 ? 'improved' : 'degraded',
                newFailures: newFailures,
                fixedTests: fixedTests,
                newTests: newTests
            },
            suites: suiteComparisons
        };
        
        return this.comparisonData;
    }

    /**
     * Calculate suite-wise comparison with baseline
     */
    calculateSuiteWiseComparison() {
        const suiteComparisons = [];
        const currentSuites = this.getSuiteStats();
        
        currentSuites.forEach(suite => {
            if (suite.total === 0) return; // Skip empty suites
            
            const currentPassRate = suite.total > 0 ? Math.round((suite.passed / suite.total) * 100) : 0;
            const baselinePassRate = 100; // Baseline is always 100%
            const difference = currentPassRate - baselinePassRate;
            
            suiteComparisons.push({
                name: suite.name,
                baseline: {
                    total: suite.total,
                    passed: suite.total,
                    failed: 0,
                    passRate: baselinePassRate
                },
                current: {
                    total: suite.total,
                    passed: suite.passed,
                    failed: suite.failed,
                    passRate: currentPassRate
                },
                difference: difference,
                trend: difference >= 0 ? 'stable' : 'degraded',
                status: currentPassRate === 100 ? 'perfect' : currentPassRate >= 80 ? 'good' : currentPassRate >= 50 ? 'warning' : 'critical'
            });
        });
        
        // Sort by difference (worst performing first)
        suiteComparisons.sort((a, b) => a.difference - b.difference);
        
        return suiteComparisons;
    }

    /**
     * Get comparison data
     */
    getComparisonData() {
        if (!this.comparisonData) {
            return this.calculateRegressionComparison();
        }
        return this.comparisonData;
    }
}

// Export for use in reporter.js
window.TestDataParser = TestDataParser;
