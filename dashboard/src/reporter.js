// Main Reporter Script for Dashboard
let parser;
let currentScope = 'all';
let currentFilter = 'all';
let currentSort = { column: null, direction: 'asc' };
let statusChart, suiteChart;

// Initialize dashboard when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    parser = new TestDataParser();
    await parser.loadData();
    initializeDashboard();
});

/**
 * Initialize the dashboard with all components
 */
function initializeDashboard() {
    refreshDashboard();
    setupEventListeners();
}

function refreshDashboard() {
    setActiveScopeTab(currentScope);
    updateScopeCounts();
    updateKPIs();
    renderRegressionComparison();
    renderAISummary();
    renderCategoryCards();
    renderCharts();
    renderTestTable();
}

function setActiveScopeTab(scope = 'all') {
    document.querySelectorAll('.scope-tab').forEach(tab => {
        const isActive = tab.dataset.scope === scope;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

function updateScopeCounts() {
    if (!parser) return;
    const allStats = parser.getScopeStats('all');
    const frontendStats = parser.getScopeStats('frontend');
    const backendStats = parser.getScopeStats('backend');
    const smokeStats = parser.getScopeStats('smoke');

    const allNode = document.getElementById('scopeAllCount');
    const feNode = document.getElementById('scopeFrontendCount');
    const beNode = document.getElementById('scopeBackendCount');
    const smokeNode = document.getElementById('scopeSmokeCount');

    if (allNode) allNode.textContent = allStats.total ?? 0;
    if (feNode) feNode.textContent = frontendStats.total ?? 0;
    if (beNode) beNode.textContent = backendStats.total ?? 0;
    if (smokeNode) smokeNode.textContent = smokeStats.total ?? 0;
}

/**
 * Update KPI cards with test statistics
 */
function updateKPIs() {
    const stats = parser.getScopeStats(currentScope);
    
    // Update project name if available
    const projectNameEl = document.getElementById('projectName');
    if (projectNameEl && parser.projectName) {
        projectNameEl.textContent = parser.projectName;
    }
    
    // Update test date
    document.getElementById('testDate').textContent = 
        TestDataParser.formatTimestamp(stats.startTime);
    
    // Update metrics
    document.getElementById('totalTests').textContent = stats.total;
    document.getElementById('passedTests').textContent = stats.passed;
    document.getElementById('failedTests').textContent = stats.failed;
    document.getElementById('skippedTests').textContent = stats.skipped;
    document.getElementById('timedoutTests').textContent = stats.timedout || 0;
    
    // Calculate and update percentages
    const passedPercentage = stats.total > 0 ? Math.round((stats.passed / stats.total) * 100) : 0;
    const failedPercentage = stats.total > 0 ? Math.round((stats.failed / stats.total) * 100) : 0;
    const skippedPercentage = stats.total > 0 ? Math.round((stats.skipped / stats.total) * 100) : 0;
    const timedoutPercentage = stats.total > 0 ? Math.round(((stats.timedout || 0) / stats.total) * 100) : 0;
    
    document.getElementById('passedPercentage').textContent = `${passedPercentage}%`;
    document.getElementById('failedPercentage').textContent = `${failedPercentage}%`;
    document.getElementById('skippedPercentage').textContent = `${skippedPercentage}%`;
    document.getElementById('timedoutPercentage').textContent = `${timedoutPercentage}%`;
    
    // Update pass rate
    document.getElementById('passRate').textContent = `${stats.passRate}%`;
    document.getElementById('passRateBar').style.width = `${stats.passRate}%`;
    
    // Update durations
    document.getElementById('totalDuration').textContent = 
        TestDataParser.formatDuration(stats.duration);
    document.getElementById('avgDuration').textContent = 
        `Avg: ${TestDataParser.formatDuration(stats.avgDuration)}`;
    
    // Update filter badges
    document.getElementById('filterAllCount').textContent = stats.total;
    document.getElementById('filterPassedCount').textContent = stats.passed;
    document.getElementById('filterFailedCount').textContent = stats.failed;
    document.getElementById('filterSkippedCount').textContent = stats.skipped;

    updateCategoryKpis();
}

function updateCategoryKpis() {
    const frontendStats = parser.getCategoryStat('Frontend');
    const backendStats = parser.getCategoryStat('Backend');

    updateCategoryKpiCard({
        totalEl: 'frontendTotal',
        passedEl: 'frontendPassed',
        failedEl: 'frontendFailed',
        passRateEl: 'frontendPassRate',
        barEl: 'frontendPassRateBar',
        stats: frontendStats
    });

    updateCategoryKpiCard({
        totalEl: 'backendTotal',
        passedEl: 'backendPassed',
        failedEl: 'backendFailed',
        passRateEl: 'backendPassRate',
        barEl: 'backendPassRateBar',
        stats: backendStats
    });
}

function updateCategoryKpiCard({ totalEl, passedEl, failedEl, passRateEl, barEl, stats }) {
    const total = stats.total || 0;
    const passed = stats.passed || 0;
    const failed = stats.failed || 0;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    const totalNode = document.getElementById(totalEl);
    const passedNode = document.getElementById(passedEl);
    const failedNode = document.getElementById(failedEl);
    const passRateNode = document.getElementById(passRateEl);
    const barNode = document.getElementById(barEl);

    if (!totalNode || !passedNode || !failedNode || !passRateNode || !barNode) {
        return;
    }

    totalNode.textContent = total;
    passedNode.textContent = passed;
    failedNode.textContent = failed;
    passRateNode.textContent = `Pass Rate: ${passRate}%`;
    barNode.style.width = `${passRate}%`;
}

/**
 * Render regression comparison section
 */
function renderRegressionComparison() {
    if (!parser) return;
    
    const comparison = parser.getComparisonData();
    if (!comparison) return;
    
    // Update baseline stats
    document.getElementById('baselinePassRate').textContent = `${comparison.baseline.passRate}%`;
    document.getElementById('baselineTotal').textContent = comparison.baseline.total;
    document.getElementById('baselinePassed').textContent = comparison.baseline.passed;
    document.getElementById('baselineFailed').textContent = comparison.baseline.failed;
    
    // Update current stats
    document.getElementById('currentPassRate').textContent = `${comparison.current.passRate}%`;
    document.getElementById('currentTotal').textContent = comparison.current.total;
    document.getElementById('currentPassed').textContent = comparison.current.passed;
    document.getElementById('currentFailed').textContent = comparison.current.failed;
    
    // Update trend
    const trendCard = document.getElementById('trendCard');
    const trendValue = document.getElementById('trendValue');
    const trendChange = document.getElementById('trendChange');
    
    if (comparison.comparison.trend === 'improved') {
        trendCard.classList.remove('degraded');
        trendCard.classList.add('improved');
        trendValue.textContent = '✓ Improved';
        trendValue.style.color = 'var(--color-success)';
    } else if (comparison.comparison.trend === 'degraded') {
        trendCard.classList.remove('improved');
        trendCard.classList.add('degraded');
        trendValue.textContent = '✗ Degraded';
        trendValue.style.color = 'var(--color-danger)';
    } else {
        trendCard.classList.remove('improved', 'degraded');
        trendValue.textContent = '= Stable';
        trendValue.style.color = 'var(--color-info)';
    }
    
    const changeText = comparison.comparison.passRateDifference >= 0 
        ? `+${comparison.comparison.passRateDifference.toFixed(1)}%` 
        : `${comparison.comparison.passRateDifference.toFixed(1)}%`;
    trendChange.textContent = changeText;
    trendChange.className = 'metric-change ' + (comparison.comparison.passRateDifference >= 0 ? 'positive' : 'negative');
    
    // Update new failures
    document.getElementById('newFailuresValue').textContent = comparison.comparison.newFailures;
    
    // Update pass rate difference
    const passRateDiff = document.getElementById('passRateDiff');
    passRateDiff.textContent = changeText;
    passRateDiff.style.color = comparison.comparison.passRateDifference >= 0 
        ? 'var(--color-success)' 
        : 'var(--color-danger)';
    
    // Update visual bars
    const currentBar = document.getElementById('currentBar');
    const currentBarValue = document.getElementById('currentBarValue');
    currentBar.style.width = `${comparison.current.passRate}%`;
    currentBarValue.textContent = `${comparison.current.passRate}%`;
    
    // Change bar color based on performance
    if (comparison.current.passRate < 80) {
        currentBar.style.background = 'linear-gradient(90deg, var(--color-danger) 0%, #dc2626 100%)';
    } else if (comparison.current.passRate < 95) {
        currentBar.style.background = 'linear-gradient(90deg, var(--color-warning) 0%, #f59e0b 100%)';
    }
    
    // Render suite-wise comparison
    renderSuiteWiseComparison(comparison);
}

/**
 * Render suite-wise comparison table
 */
function renderSuiteWiseComparison(comparison) {
    if (!comparison || !comparison.suites || comparison.suites.length === 0) {
        return;
    }
    
    const tbody = document.getElementById('suiteComparisonTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    comparison.suites.forEach(suite => {
        const row = document.createElement('tr');
        
        // Suite Name
        const nameCell = document.createElement('td');
        nameCell.className = 'suite-name-cell';
        nameCell.textContent = suite.name;
        row.appendChild(nameCell);
        
        // Main Branch (Baseline)
        const baselineCell = document.createElement('td');
        baselineCell.innerHTML = `
            <div class="suite-pass-rate">
                <div class="suite-pass-rate-bar">
                    <div class="suite-pass-rate-fill baseline" style="width: ${suite.baseline.passRate}%"></div>
                </div>
                <span class="suite-pass-rate-text">${suite.baseline.passRate}%</span>
            </div>
        `;
        row.appendChild(baselineCell);
        
        // Current Branch
        const currentCell = document.createElement('td');
        currentCell.innerHTML = `
            <div class="suite-pass-rate">
                <div class="suite-pass-rate-bar">
                    <div class="suite-pass-rate-fill ${suite.status}" style="width: ${suite.current.passRate}%"></div>
                </div>
                <span class="suite-pass-rate-text">${suite.current.passRate}%</span>
            </div>
        `;
        row.appendChild(currentCell);
        
        // Difference
        const diffCell = document.createElement('td');
        const diffClass = suite.difference > 0 ? 'positive' : suite.difference < 0 ? 'negative' : 'neutral';
        const diffSign = suite.difference > 0 ? '+' : '';
        diffCell.innerHTML = `<span class="suite-difference ${diffClass}">${diffSign}${suite.difference}%</span>`;
        row.appendChild(diffCell);
        
        // Status
        const statusCell = document.createElement('td');
        let statusIcon = '';
        let statusText = '';
        
        switch (suite.status) {
            case 'perfect':
                statusIcon = '<i class="fas fa-check-circle"></i>';
                statusText = 'Perfect';
                break;
            case 'good':
                statusIcon = '<i class="fas fa-check"></i>';
                statusText = 'Good';
                break;
            case 'warning':
                statusIcon = '<i class="fas fa-exclamation-triangle"></i>';
                statusText = 'Warning';
                break;
            case 'critical':
                statusIcon = '<i class="fas fa-times-circle"></i>';
                statusText = 'Critical';
                break;
        }
        
        statusCell.innerHTML = `<span class="suite-status-badge ${suite.status}">${statusIcon} ${statusText}</span>`;
        row.appendChild(statusCell);
        
        tbody.appendChild(row);
    });
}

let currentSuiteCardIndex = 0;
let suiteCards = [];

function renderCategoryCards() {
    // Use suite stats and filter to only show suites that actually ran (total > 0)
    const allSuites = parser.getSuiteStats();
    const activeSuites = allSuites.filter(suite => suite.total > 0);
    
    const container = document.getElementById('categoryCards');
    if (!container) return;
    
    // Store for carousel navigation
    suiteCards = activeSuites;
    currentSuiteCardIndex = 0;
    
    // Clear and set up carousel structure
    container.innerHTML = `
        <div class="suite-carousel-wrapper">
            <button class="suite-carousel-nav suite-carousel-prev" id="suiteCarouselPrev" ${activeSuites.length <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-left"></i>
            </button>
            <div class="suite-carousel-container" id="suiteCarouselContainer">
                <!-- Cards will be inserted here -->
            </div>
            <button class="suite-carousel-nav suite-carousel-next" id="suiteCarouselNext" ${activeSuites.length <= 1 ? 'disabled' : ''}>
                <i class="fas fa-chevron-right"></i>
            </button>
        </div>
        <div class="suite-carousel-counter" id="suiteCarouselCounter">
            ${activeSuites.length > 0 ? `1 / ${activeSuites.length}` : '0 / 0'}
        </div>
    `;
    
    const carouselContainer = document.getElementById('suiteCarouselContainer');
    if (!carouselContainer) return;

    activeSuites.forEach((suite, index) => {
        const card = document.createElement('div');
        card.className = 'category-card suite-carousel-card';
        if (index === 0) card.classList.add('active');
        
        const passRate = suite.total ? Math.round((suite.passed / suite.total) * 100) : 0;
        card.innerHTML = `
            <div class="category-card__header">
                <h3>${escapeHtml(suite.name)}</h3>
                <span class="badge">${suite.total} tests</span>
            </div>
            <div class="category-card__metrics">
                <div>
                    <span class="label">Passed</span>
                    <strong>${suite.passed}</strong>
                </div>
                <div>
                    <span class="label">Failed</span>
                    <strong>${suite.failed}</strong>
                </div>
                <div>
                    <span class="label">Skipped</span>
                    <strong>${suite.skipped}</strong>
                </div>
            </div>
            <div class="category-card__progress">
                <span>Pass Rate</span>
                <div class="progress-bar">
                    <div class="progress-fill" style="width:${passRate}%;"></div>
                </div>
                <span class="pass-rate">${passRate}%</span>
            </div>
        `;
        carouselContainer.appendChild(card);
    });
    
    // Setup navigation
    setupSuiteCarouselNavigation();
}

function setupSuiteCarouselNavigation() {
    const prevBtn = document.getElementById('suiteCarouselPrev');
    const nextBtn = document.getElementById('suiteCarouselNext');
    
    if (!prevBtn || !nextBtn) return;
    
    prevBtn.addEventListener('click', () => navigateSuiteCarousel(-1));
    nextBtn.addEventListener('click', () => navigateSuiteCarousel(1));
}

function navigateSuiteCarousel(direction) {
    const container = document.getElementById('suiteCarouselContainer');
    if (!container || suiteCards.length === 0) return;
    
    const cards = container.querySelectorAll('.suite-carousel-card');
    if (cards.length === 0) return;
    
    // Remove active class from current card
    cards[currentSuiteCardIndex].classList.remove('active');
    
    // Update index
    currentSuiteCardIndex += direction;
    if (currentSuiteCardIndex < 0) currentSuiteCardIndex = cards.length - 1;
    if (currentSuiteCardIndex >= cards.length) currentSuiteCardIndex = 0;
    
    // Add active class to new card
    cards[currentSuiteCardIndex].classList.add('active');
    
    // Update counter
    const counter = document.getElementById('suiteCarouselCounter');
    if (counter) {
        counter.textContent = `${currentSuiteCardIndex + 1} / ${cards.length}`;
    }
    
    // Update button states
    const prevBtn = document.getElementById('suiteCarouselPrev');
    const nextBtn = document.getElementById('suiteCarouselNext');
    if (prevBtn) prevBtn.disabled = false;
    if (nextBtn) nextBtn.disabled = false;
}

/**
 * Render AI Analysis Summary section
 */
let currentAICardIndex = 0;
let aiAnalysisCards = [];

function renderAISummary() {
    console.log('🤖 renderAISummary called');
    
    const aiSummarySection = document.getElementById('aiSummarySection');
    const aiSummaryCarousel = document.getElementById('aiSummaryCarousel');
    const aiSummaryBadge = document.getElementById('aiSummaryBadge');
    const aiSummaryCounter = document.getElementById('aiSummaryCounter');
    
    console.log('  - aiSummarySection:', aiSummarySection ? 'found' : 'NOT FOUND');
    console.log('  - aiSummaryCarousel:', aiSummaryCarousel ? 'found' : 'NOT FOUND');
    console.log('  - parser:', parser ? 'exists' : 'NOT EXISTS');
    
    if (!parser || !aiSummarySection || !aiSummaryCarousel) {
        console.log('  ❌ Early return: missing required elements');
        return;
    }
    
    // Get all tests with AI analysis
    let testsWithAI = parser.getTests().filter(test => test.aiAnalysis);
    console.log('  - Tests with AI analysis:', testsWithAI.length);
    console.log('  - parser.aiAnalysisData:', parser.aiAnalysisData ? 'exists' : 'NOT EXISTS');
    
    if (parser.aiAnalysisData) {
        console.log('  - AI analyses count:', Object.keys(parser.aiAnalysisData.analyses || {}).length);
    }
    
    // If no tests have AI analysis but AI data exists, create pseudo-tests from AI data
    if (testsWithAI.length === 0 && parser.aiAnalysisData && parser.aiAnalysisData.analyses) {
        console.log('  ✓ Creating pseudo-tests from AI analysis data');
        testsWithAI = Object.values(parser.aiAnalysisData.analyses).map(analysis => ({
            id: analysis.testName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, ''),
            title: analysis.testName,
            fullTitle: analysis.testName,
            suite: 'Unknown Suite',
            category: analysis.file.includes('frontend') ? 'Frontend' : analysis.file.includes('backend') ? 'Backend' : 'Other',
            status: 'failed',
            duration: 0,
            error: analysis.error,
            retries: 0,
            file: analysis.file,
            attachments: [],
            aiAnalysis: analysis.aiAnalysis
        }));
    }
    
    console.log('  - Final testsWithAI count:', testsWithAI.length);
    
    if (testsWithAI.length === 0) {
        console.log('  ❌ No tests with AI analysis - hiding section');
        aiSummarySection.style.display = 'none';
        return;
    }
    
    // Show section and update badge
    console.log('  ✓ Showing AI Summary section with', testsWithAI.length, 'analyses');
    aiSummarySection.style.display = 'block';
    aiSummaryBadge.textContent = `${testsWithAI.length} ${testsWithAI.length === 1 ? 'analysis' : 'analyses'}`;
    
    // Clear existing content
    aiSummaryCarousel.innerHTML = '';
    aiAnalysisCards = testsWithAI;
    currentAICardIndex = 0;
    
    // Create cards for each test with AI analysis
    testsWithAI.forEach((test, index) => {
        console.log(`  - Creating card ${index + 1}:`, test.title);
        const card = createAISummaryCard(test);
        if (index === 0) {
            card.classList.add('active');
        }
        aiSummaryCarousel.appendChild(card);
    });
    
    // Update counter
    updateAICarouselCounter();
    
    // Setup navigation
    setupAICarouselNavigation();
    
    console.log('  ✅ AI Summary section rendered successfully');
}

function updateAICarouselCounter() {
    const counter = document.getElementById('aiSummaryCounter');
    if (counter && aiAnalysisCards.length > 0) {
        counter.textContent = `${currentAICardIndex + 1} / ${aiAnalysisCards.length}`;
    }
}

function setupAICarouselNavigation() {
    const prevBtn = document.getElementById('aiCarouselPrev');
    const nextBtn = document.getElementById('aiCarouselNext');
    
    if (!prevBtn || !nextBtn) return;
    
    // Remove old listeners
    prevBtn.replaceWith(prevBtn.cloneNode(true));
    nextBtn.replaceWith(nextBtn.cloneNode(true));
    
    const newPrevBtn = document.getElementById('aiCarouselPrev');
    const newNextBtn = document.getElementById('aiCarouselNext');
    
    newPrevBtn.addEventListener('click', () => navigateAICarousel(-1));
    newNextBtn.addEventListener('click', () => navigateAICarousel(1));
    
    updateNavigationButtons();
}

function navigateAICarousel(direction) {
    const carousel = document.getElementById('aiSummaryCarousel');
    if (!carousel) return;
    
    const cards = carousel.querySelectorAll('.ai-summary-card');
    if (cards.length === 0) return;
    
    // Remove active class from current card
    cards[currentAICardIndex].classList.remove('active');
    if (direction < 0) {
        cards[currentAICardIndex].classList.add('prev');
    }
    
    // Update index
    currentAICardIndex += direction;
    currentAICardIndex = Math.max(0, Math.min(currentAICardIndex, cards.length - 1));
    
    // Add active class to new card
    cards[currentAICardIndex].classList.add('active');
    cards[currentAICardIndex].classList.remove('prev');
    
    // Update counter and buttons
    updateAICarouselCounter();
    updateNavigationButtons();
}

function updateNavigationButtons() {
    const prevBtn = document.getElementById('aiCarouselPrev');
    const nextBtn = document.getElementById('aiCarouselNext');
    
    if (!prevBtn || !nextBtn) return;
    
    prevBtn.disabled = currentAICardIndex === 0;
    nextBtn.disabled = currentAICardIndex === aiAnalysisCards.length - 1;
}

/**
 * Create AI summary card for a test
 */
function createAISummaryCard(test) {
    const card = document.createElement('div');
    card.className = 'ai-summary-card';
    
    const analysis = test.aiAnalysis;
    const confidencePercent = Math.round(analysis.confidence * 100);
    const confidenceClass = confidencePercent >= 80 ? 'high' : confidencePercent >= 50 ? 'medium' : 'low';
    
    card.innerHTML = `
        <div class="ai-summary-card-header">
            <div class="ai-summary-card-title">
                <i class="fas fa-vial"></i>
                <span>${escapeHtml(test.title)}</span>
            </div>
            <span class="confidence-badge confidence-${confidenceClass}">${confidencePercent}% confidence</span>
        </div>
        
        <div class="ai-summary-card-meta">
            <span class="ai-summary-suite"><i class="fas fa-folder"></i> ${escapeHtml(test.suite.split(' › ').pop())}</span>
            <span class="ai-summary-provider"><i class="fas fa-robot"></i> ${escapeHtml(analysis.aiProvider)} ${escapeHtml(analysis.model)}</span>
        </div>
        
        <div class="ai-summary-card-content">
            <div class="ai-summary-item">
                <div class="ai-summary-item-label">
                    <i class="fas fa-info-circle"></i> What & Why
                </div>
                <div class="ai-summary-item-text">
                    ${analysis.analysis ? escapeHtml(analysis.analysis) : 'No analysis available'}
                </div>
            </div>
            
            ${analysis.rootCause ? `
                <div class="ai-summary-item">
                    <div class="ai-summary-item-label">
                        <i class="fas fa-bug"></i> Root Cause
                    </div>
                    <div class="ai-summary-item-text">
                        ${escapeHtml(analysis.rootCause)}
                    </div>
                </div>
            ` : ''}
            
            ${analysis.suggestedFix?.description ? `
                <div class="ai-summary-item">
                    <div class="ai-summary-item-label">
                        <i class="fas fa-wrench"></i> Suggested Fix
                    </div>
                    <div class="ai-summary-item-text">
                        ${escapeHtml(analysis.suggestedFix.description)}
                    </div>
                </div>
            ` : ''}
            
            ${analysis.affectedFiles && analysis.affectedFiles.length > 0 ? `
                <div class="ai-summary-item">
                    <div class="ai-summary-item-label">
                        <i class="fas fa-file-code"></i> Affected Files
                    </div>
                    <div class="ai-summary-files">
                        ${analysis.affectedFiles.map(file => 
                            `<code>${escapeHtml(file)}</code>`
                        ).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
    
    return card;
}

/**
 * Apply AI-suggested fix for a specific test
 */
async function applyAIFix(testFile, testTitle) {
    const button = event.target.closest('.btn-apply-fix');
    if (!button) return;
    
    // Disable button and show loading state
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying Fix...';
    
    try {
        console.log('Applying fix for:', testFile, testTitle);
        
        // Call the fix application endpoint
        const response = await fetch('http://localhost:3001/apply-fix', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                testFile,
                testTitle
            })
        });
        
        if (!response.ok) {
            throw new Error(`Fix application failed: ${response.statusText}`);
        }
        
        const result = await response.json();
        
        // Show success state
        button.innerHTML = '<i class="fas fa-check"></i> Fix Applied!';
        button.style.background = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)';
        
        // Show notification
        showNotification('Fix applied successfully! Running verification tests...', 'success');
        
        console.log('Fix application result:', result);
        
    } catch (error) {
        console.error('Error applying fix:', error);
        
        // Show error state
        button.disabled = false;
        button.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Fix Failed';
        button.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
        
        showNotification(`Failed to apply fix: ${error.message}`, 'error');
        
        // Reset button after 3 seconds
        setTimeout(() => {
            button.innerHTML = '<i class="fas fa-magic"></i> Apply Fix';
            button.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
        }, 3000);
    }
}

/**
 * Show notification message
 */
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i>
        <span>${message}</span>
    `;
    
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => notification.classList.add('show'), 10);
    
    // Remove after 5 seconds
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

/**
 * Render charts using Chart.js
 */
function renderCharts() {
    const stats = parser.getScopeStats(currentScope);
    const suiteStats = parser.getSuiteStatsByScope(currentScope);
    
    if (statusChart) {
        statusChart.destroy();
    }
    if (suiteChart) {
        suiteChart.destroy();
    }
    
    // Status Distribution Pie Chart
    const statusCtx = document.getElementById('statusChart').getContext('2d');
    statusChart = new Chart(statusCtx, {
        type: 'doughnut',
        data: {
            labels: ['Passed', 'Failed', 'Skipped'],
            datasets: [{
                data: [stats.passed, stats.failed, stats.skipped],
                backgroundColor: [
                    'rgba(16, 185, 129, 0.8)',
                    'rgba(239, 68, 68, 0.8)',
                    'rgba(245, 158, 11, 0.8)'
                ],
                borderColor: [
                    'rgba(16, 185, 129, 1)',
                    'rgba(239, 68, 68, 1)',
                    'rgba(245, 158, 11, 1)'
                ],
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        padding: 15,
                        font: {
                            size: 12,
                            family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const percentage = stats.total > 0 
                                ? Math.round((value / stats.total) * 100) 
                                : 0;
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
    
    // Suite Results Bar Chart
    const suiteCtx = document.getElementById('suiteChart').getContext('2d');
    const suiteLabels = suiteStats.map(s => s.name.split(' › ').pop());
    const suiteData = {
        passed: suiteStats.map(s => s.passed),
        failed: suiteStats.map(s => s.failed),
        skipped: suiteStats.map(s => s.skipped)
    };
    
    suiteChart = new Chart(suiteCtx, {
        type: 'bar',
        data: {
            labels: suiteLabels,
            datasets: [
                {
                    label: 'Passed',
                    data: suiteData.passed,
                    backgroundColor: 'rgba(16, 185, 129, 0.8)',
                    borderColor: 'rgba(16, 185, 129, 1)',
                    borderWidth: 1
                },
                {
                    label: 'Failed',
                    data: suiteData.failed,
                    backgroundColor: 'rgba(239, 68, 68, 0.8)',
                    borderColor: 'rgba(239, 68, 68, 1)',
                    borderWidth: 1
                },
                {
                    label: 'Skipped',
                    data: suiteData.skipped,
                    backgroundColor: 'rgba(245, 158, 11, 0.8)',
                    borderColor: 'rgba(245, 158, 11, 1)',
                    borderWidth: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        padding: 15,
                        font: {
                            size: 12,
                            family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
                        }
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    grid: {
                        display: false
                    }
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            }
        }
    });
}

/**
 * Render test results table
 */
function renderTestTable() {
    const tests = getFilteredAndSortedTests();
    const tbody = document.getElementById('resultsTableBody');
    const noResults = document.getElementById('noResults');
    
    tbody.innerHTML = '';
    
    if (tests.length === 0) {
        noResults.style.display = 'block';
        return;
    }
    
    noResults.style.display = 'none';
    
    tests.forEach(test => {
        const row = createTestRow(test);
        tbody.appendChild(row);
    });
}

/**
 * Create a table row for a test
 */
function createTestRow(test) {
    const tr = document.createElement('tr');
    tr.dataset.testId = test.id;
    tr.dataset.status = test.status;
    tr.dataset.suite = test.suite;
    
    // Normalize status
    let normalizedStatus = test.status;
    if (test.status === 'expected') normalizedStatus = 'passed';
    if (test.status === 'unexpected') normalizedStatus = 'failed';
    if (test.status === 'pending') normalizedStatus = 'skipped';
    
    // Extract Jira story key from test data or file name
    let jiraStoryKey = '';
    let jiraLink = '';
    if (test.jiraStory) {
        jiraStoryKey = test.jiraStory.key;
        jiraLink = test.jiraStory.url || `#${jiraStoryKey}`;
    } else if (test.file) {
        // Try to extract from file name (generic pattern: projectkey_number)
        const match = test.file.match(/([a-z]+)[_-]?(\d+)/i);
        if (match) {
            jiraStoryKey = `${match[1].toUpperCase()}-${match[2]}`;
        }
    }
    
    tr.innerHTML = `
        <td>
            <div class="test-name">
                ${escapeHtml(test.title)}
                ${test.aiAnalysis ? '<span class="ai-indicator" title="AI Analysis Available"><i class="fas fa-robot"></i></span>' : ''}
            </div>
            ${test.retries > 0 ? `<small style="color: var(--color-warning)">Retried ${test.retries} time(s)</small>` : ''}
        </td>
        <td>${escapeHtml(test.suite.split(' › ').pop())}</td>
        <td>
            ${jiraStoryKey ? `<a href="${jiraLink}" target="_blank" class="jira-link" title="View in Jira">
                <i class="fab fa-jira"></i> ${jiraStoryKey}
            </a>` : '<span style="color: #999;">N/A</span>'}
        </td>
        <td>
            <span class="status-badge status-${normalizedStatus}">
                ${TestDataParser.getStatusIcon(normalizedStatus)}
                ${normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1)}
            </span>
        </td>
        <td>${TestDataParser.formatDuration(test.duration)}</td>
        <td>
            <button class="btn-details" data-test-id="${test.id}">
                <i class="fas fa-info-circle"></i> Details
            </button>
        </td>
    `;
    
    return tr;
}

/**
 * Get filtered and sorted tests
 */
function getFilteredAndSortedTests() {
    let tests = parser.getTestsByScope(currentScope);
    
    // Apply search filter
    const searchQuery = document.getElementById('searchInput').value;
    if (searchQuery) {
        const lowerQuery = searchQuery.toLowerCase();
        tests = tests.filter(test =>
            test.title.toLowerCase().includes(lowerQuery) ||
            test.suite.toLowerCase().includes(lowerQuery)
        );
    }
    
    // Apply status filter
    if (currentFilter !== 'all') {
        tests = tests.filter(test => {
            const status = test.status === 'expected' ? 'passed' : 
                          test.status === 'unexpected' ? 'failed' : 
                          test.status === 'pending' ? 'skipped' : 
                          test.status;
            return status === currentFilter;
        });
    }
    
    // Apply sorting
    if (currentSort.column) {
        tests = sortTests(tests, currentSort.column, currentSort.direction);
    }
    
    return tests;
}

/**
 * Sort tests by column
 */
function sortTests(tests, column, direction) {
    return [...tests].sort((a, b) => {
        let aVal, bVal;
        
        switch (column) {
            case 'name':
                aVal = a.title.toLowerCase();
                bVal = b.title.toLowerCase();
                break;
            case 'suite':
                aVal = a.suite.toLowerCase();
                bVal = b.suite.toLowerCase();
                break;
            case 'status':
                aVal = a.status;
                bVal = b.status;
                break;
            case 'duration':
                aVal = a.duration;
                bVal = b.duration;
                break;
            default:
                return 0;
        }
        
        if (aVal < bVal) return direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return direction === 'asc' ? 1 : -1;
        return 0;
    });
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Scope tabs
    document.querySelectorAll('.scope-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const selectedScope = tab.dataset.scope || 'all';
            if (selectedScope === currentScope) return;
            currentScope = selectedScope;
            refreshDashboard();
        });
    });

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderTestTable();
        });
    });
    
    // Search input
    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', debounce(() => {
        renderTestTable();
    }, 300));
    
    // Sortable columns
    document.querySelectorAll('.sortable').forEach(th => {
        th.addEventListener('click', () => {
            const column = th.dataset.sort;
            
            if (currentSort.column === column) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.column = column;
                currentSort.direction = 'asc';
            }
            
            // Update sort icons
            document.querySelectorAll('.sortable i').forEach(i => {
                i.className = 'fas fa-sort';
            });
            
            const icon = th.querySelector('i');
            icon.className = currentSort.direction === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
            
            renderTestTable();
        });
    });
    
    // Details buttons - using event delegation
    document.getElementById('resultsTableBody').addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-details');
        if (btn) {
            const testId = btn.getAttribute('data-test-id');
            if (testId) {
                showTestDetails(testId);
            }
        }
    });
    
    // Regression comparison collapse/expand button
    const regressionCollapseBtn = document.getElementById('regressionCollapseBtn');
    const regressionContent = document.getElementById('regressionComparisonContent');
    
    if (regressionCollapseBtn && regressionContent) {
        regressionCollapseBtn.addEventListener('click', () => {
            const isExpanded = regressionCollapseBtn.getAttribute('aria-expanded') === 'true';
            
            if (isExpanded) {
                // Collapse
                regressionContent.classList.add('collapsed');
                regressionCollapseBtn.setAttribute('aria-expanded', 'false');
                regressionCollapseBtn.querySelector('.toggle-text').textContent = 'Expand';
            } else {
                // Expand
                regressionContent.classList.remove('collapsed');
                regressionCollapseBtn.setAttribute('aria-expanded', 'true');
                regressionCollapseBtn.querySelector('.toggle-text').textContent = 'Collapse';
            }
        });
    }
}

/**
 * Show test details in modal
 */
function showTestDetails(testId) {
    const test = parser.getTests().find(t => t.id === testId);
    if (!test) return;
    
    const modal = document.getElementById('testModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    
    modalTitle.textContent = test.title;
    
    let statusClass = test.status === 'expected' ? 'passed' : 
                     test.status === 'unexpected' ? 'failed' : 
                     test.status === 'pending' ? 'skipped' : 
                     test.status;
    
    modalBody.innerHTML = `
        <div class="test-detail-item">
            <strong>Suite:</strong> ${escapeHtml(test.suite)}
        </div>
        <div class="test-detail-item">
            <strong>Status:</strong>
            <span class="status-badge status-${statusClass}">
                ${TestDataParser.getStatusIcon(statusClass)}
                ${statusClass.charAt(0).toUpperCase() + statusClass.slice(1)}
            </span>
        </div>
        <div class="test-detail-item">
            <strong>Duration:</strong> ${TestDataParser.formatDuration(test.duration)}
        </div>
        <div class="test-detail-item">
            <strong>File:</strong> <code>${escapeHtml(test.file)}</code>
        </div>
        ${test.retries > 0 ? `
            <div class="test-detail-item">
                <strong>Retries:</strong> ${test.retries}
            </div>
        ` : ''}
        ${test.error ? `
            <div class="error-details">
                <h4><i class="fas fa-exclamation-triangle"></i> Error Details</h4>
                <p><strong>Message:</strong> ${escapeHtml(test.error.message)}</p>
                ${test.error.stack ? `
                    <pre>${escapeHtml(test.error.stack)}</pre>
                ` : ''}
            </div>
        ` : ''}
        ${renderAIAnalysis(test)}
        ${renderTestArtifacts(test)}
    `;
    
    modal.classList.add('active');
}

/**
 * Render AI analysis section
 */
function renderAIAnalysis(test) {
    if (!test.aiAnalysis) {
        return '';
    }

    const analysis = test.aiAnalysis;
    const confidencePercent = Math.round(analysis.confidence * 100);
    const confidenceClass = confidencePercent >= 80 ? 'high' : confidencePercent >= 50 ? 'medium' : 'low';

    let html = `
        <div class="ai-analysis-section">
            <h4>
                <i class="fas fa-robot"></i> AI Analysis 
                <span class="ai-badge">${escapeHtml(analysis.aiProvider)} ${escapeHtml(analysis.model)}</span>
                <span class="confidence-badge confidence-${confidenceClass}">${confidencePercent}% confidence</span>
            </h4>
    `;

    if (analysis.analysis) {
        html += `
            <div class="ai-analysis-item">
                <strong><i class="fas fa-info-circle"></i> What is this test about?</strong>
                <p>${escapeHtml(analysis.analysis)}</p>
            </div>
        `;
    }

    if (analysis.rootCause) {
        html += `
            <div class="ai-analysis-item">
                <strong><i class="fas fa-bug"></i> Why is it failing?</strong>
                <p>${escapeHtml(analysis.rootCause)}</p>
            </div>
        `;
    }

    if (analysis.suggestedFix && analysis.suggestedFix.description) {
        html += `
            <div class="ai-analysis-item">
                <strong><i class="fas fa-wrench"></i> How to fix it?</strong>
                <p>${escapeHtml(analysis.suggestedFix.description)}</p>
        `;

        if (analysis.suggestedFix.changes && analysis.suggestedFix.changes.length > 0) {
            html += `<div class="fix-changes">`;
            analysis.suggestedFix.changes.forEach((change, idx) => {
                html += `
                    <div class="fix-change-item">
                        <div class="fix-change-header">
                            <strong>Change ${idx + 1}:</strong> ${escapeHtml(change.file)}
                            <span class="fix-action-badge">${escapeHtml(change.action)}</span>
                        </div>
                        ${change.lineStart ? `<div class="fix-lines">Lines ${change.lineStart}${change.lineEnd ? '-' + change.lineEnd : ''}</div>` : ''}
                    </div>
                `;
            });
            html += `</div>`;
        }

        html += `</div>`;
    }

    if (analysis.affectedFiles && analysis.affectedFiles.length > 0) {
        html += `
            <div class="ai-analysis-item">
                <strong><i class="fas fa-file-code"></i> Affected Files:</strong>
                <ul class="affected-files-list">
                    ${analysis.affectedFiles.map(file => `<li><code>${escapeHtml(file)}</code></li>`).join('')}
                </ul>
            </div>
        `;
    }

    if (analysis.testingRecommendations) {
        html += `
            <div class="ai-analysis-item">
                <strong><i class="fas fa-clipboard-check"></i> Testing Recommendations:</strong>
                <p>${escapeHtml(analysis.testingRecommendations)}</p>
            </div>
        `;
    }

    html += `</div>`;
    return html;
}

/**
 * Close modal
 */
function closeModal() {
    document.getElementById('testModal').classList.remove('active');
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
    const testModal = document.getElementById('testModal');
    const artifactModal = document.getElementById('artifactModal');
    
    if (e.target === testModal) {
        closeModal();
    }
    if (e.target === artifactModal) {
        closeArtifactModal();
    }
});

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const testModal = document.getElementById('testModal');
        const artifactModal = document.getElementById('artifactModal');
        
        if (artifactModal.classList.contains('active')) {
            closeArtifactModal();
        } else if (testModal.classList.contains('active')) {
            closeModal();
        }
    }
});

/**
 * Utility: Debounce function
 */
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Utility: Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Render test artifacts section
 */
function renderTestArtifacts(test) {
    if (!test.attachments) {
        return '';
    }

    const { screenshots, videos, traces, other } = test.attachments;
    const hasArtifacts = screenshots.length > 0 || videos.length > 0 || traces.length > 0 || other.length > 0;

    if (!hasArtifacts) {
        return '';
    }

    let html = '<div class="test-artifacts"><h4><i class="fas fa-paperclip"></i> Test Artifacts</h4>';

    // Screenshots section
    if (screenshots.length > 0) {
        html += `
            <div class="artifact-section">
                <div class="artifact-section-title">
                    <i class="fas fa-image"></i> Screenshots
                    <span class="artifact-badge">${screenshots.length}</span>
                </div>
                <div class="artifacts-grid">
                    ${screenshots.map((screenshot, index) => `
                        <div class="artifact-item" onclick="viewArtifact('${escapeHtml(screenshot.path)}', 'image', '${escapeHtml(screenshot.name)}')">
                            <img src="${escapeHtml(screenshot.path)}" alt="${escapeHtml(screenshot.name)}" class="screenshot-preview" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                            <div class="artifact-item-icon" style="display:none;"><i class="fas fa-image"></i></div>
                            <div class="artifact-item-name">${escapeHtml(screenshot.name)}</div>
                            <div class="artifact-item-type">PNG Image</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Videos section
    if (videos.length > 0) {
        html += `
            <div class="artifact-section">
                <div class="artifact-section-title">
                    <i class="fas fa-video"></i> Videos
                    <span class="artifact-badge">${videos.length}</span>
                </div>
                <div class="artifacts-grid">
                    ${videos.map((video, index) => `
                        <div class="artifact-item" onclick="viewArtifact('${escapeHtml(video.path)}', 'video', '${escapeHtml(video.name)}')">
                            <div class="artifact-item-icon"><i class="fas fa-video"></i></div>
                            <div class="artifact-item-name">${escapeHtml(video.name)}</div>
                            <div class="artifact-item-type">WebM Video</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Traces section - with Playwright trace viewer integration
    if (traces.length > 0) {
        html += `
            <div class="artifact-section">
                <div class="artifact-section-title">
                    <i class="fas fa-file-archive"></i> Traces
                    <span class="artifact-badge">${traces.length}</span>
                </div>
                <div class="artifacts-grid">
                    ${traces.map((trace, index) => `
                        <div class="artifact-item trace-artifact">
                            <div class="artifact-item-icon"><i class="fas fa-file-archive"></i></div>
                            <div class="artifact-item-name">${escapeHtml(trace.name)}</div>
                            <div class="artifact-item-type">Trace File</div>
                            <div class="artifact-actions">
                                <button class="btn-view-trace" onclick="viewTraceInViewer('${escapeHtml(trace.path)}')">
                                    <i class="fas fa-external-link-alt"></i> View in Trace Viewer
                                </button>
                                <a href="${escapeHtml(trace.path)}" download class="btn-download-trace">
                                    <i class="fas fa-download"></i> Download
                                </a>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Other attachments section
    if (other.length > 0) {
        html += `
            <div class="artifact-section">
                <div class="artifact-section-title">
                    <i class="fas fa-file"></i> Other Files
                    <span class="artifact-badge">${other.length}</span>
                </div>
                <div class="artifacts-grid">
                    ${other.map((file, index) => `
                        <div class="artifact-item" onclick="window.open('${escapeHtml(file.path)}', '_blank')">
                            <div class="artifact-item-icon"><i class="fas fa-file"></i></div>
                            <div class="artifact-item-name">${escapeHtml(file.name)}</div>
                            <div class="artifact-item-type">${escapeHtml(file.contentType)}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    html += '</div>';
    return html;
}

/**
 * View artifact in modal
 */
function viewArtifact(path, type, name) {
    const modal = document.getElementById('artifactModal');
    const modalTitle = document.getElementById('artifactModalTitle');
    const modalBody = document.getElementById('artifactModalBody');

    modalTitle.textContent = name;

    let content = '';
    if (type === 'image') {
        content = `
            <div class="artifact-viewer-content">
                <div class="artifact-viewer-media">
                    <img src="${escapeHtml(path)}" alt="${escapeHtml(name)}">
                </div>
                <div class="artifact-viewer-info">
                    <div class="artifact-viewer-info-item">
                        <strong>Name:</strong>
                        <span>${escapeHtml(name)}</span>
                    </div>
                    <div class="artifact-viewer-info-item">
                        <strong>Type:</strong>
                        <span>Screenshot</span>
                    </div>
                    <div class="artifact-viewer-info-item">
                        <a href="${escapeHtml(path)}" download class="artifact-download-btn">
                            <i class="fas fa-download"></i> Download
                        </a>
                    </div>
                </div>
            </div>
        `;
    } else if (type === 'video') {
        content = `
            <div class="artifact-viewer-content">
                <div class="artifact-viewer-media">
                    <video controls>
                        <source src="${escapeHtml(path)}" type="video/webm">
                        Your browser does not support the video tag.
                    </video>
                </div>
                <div class="artifact-viewer-info">
                    <div class="artifact-viewer-info-item">
                        <strong>Name:</strong>
                        <span>${escapeHtml(name)}</span>
                    </div>
                    <div class="artifact-viewer-info-item">
                        <strong>Type:</strong>
                        <span>Test Recording</span>
                    </div>
                    <div class="artifact-viewer-info-item">
                        <a href="${escapeHtml(path)}" download class="artifact-download-btn">
                            <i class="fas fa-download"></i> Download
                        </a>
                    </div>
                </div>
            </div>
        `;
    }

    modalBody.innerHTML = content;
    modal.classList.add('active');
}

/**
 * Close artifact modal
 */
function closeArtifactModal() {
    document.getElementById('artifactModal').classList.remove('active');
}

/**
 * View trace in Playwright Trace Viewer
 * Opens trace in trace.playwright.dev
 */
function viewTraceInViewer(tracePath) {
    // Playwright's online trace viewer can open traces by URL
    // For local traces, we need to use file:// or serve them
    const traceViewerUrl = 'https://trace.playwright.dev/';
    
    // Try to get absolute URL for the trace
    let absoluteTraceUrl = tracePath;
    if (!tracePath.startsWith('http')) {
        // For file:// protocol, construct the full path
        const currentUrl = window.location.href;
        const baseUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1);
        absoluteTraceUrl = baseUrl + tracePath;
    }
    
    // For local files, inform user about options
    if (absoluteTraceUrl.startsWith('file://')) {
        // Open the online trace viewer and show instructions
        const modal = document.getElementById('artifactModal');
        const modalTitle = document.getElementById('artifactModalTitle');
        const modalBody = document.getElementById('artifactModalBody');
        
        modalTitle.textContent = 'View Trace';
        modalBody.innerHTML = `
            <div class="trace-viewer-info">
                <h4><i class="fas fa-info-circle"></i> How to View This Trace</h4>
                
                <div class="trace-option">
                    <h5>Option 1: Online Trace Viewer (Recommended)</h5>
                    <p>1. Click the button below to open Playwright's Trace Viewer</p>
                    <p>2. Drag and drop the downloaded trace file into the viewer</p>
                    <a href="https://trace.playwright.dev/" target="_blank" class="btn-open-viewer">
                        <i class="fas fa-external-link-alt"></i> Open Trace Viewer
                    </a>
                </div>
                
                <div class="trace-option">
                    <h5>Option 2: Command Line</h5>
                    <p>Run this command in your terminal:</p>
                    <pre><code>npx playwright show-trace "${tracePath}"</code></pre>
                </div>
                
                <div class="trace-download">
                    <a href="${tracePath}" download class="btn-download">
                        <i class="fas fa-download"></i> Download Trace File
                    </a>
                </div>
            </div>
        `;
        
        modal.classList.add('active');
    } else {
        // For HTTP URLs, try to open directly in trace viewer
        const viewerUrl = `${traceViewerUrl}?trace=${encodeURIComponent(absoluteTraceUrl)}`;
        window.open(viewerUrl, '_blank');
    }
}

/**
 * Get artifact stats for a test
 */
function getArtifactStats(test) {
    if (!test.attachments) {
        return { total: 0, screenshots: 0, videos: 0, traces: 0 };
    }
    
    const { screenshots, videos, traces, other } = test.attachments;
    return {
        total: (screenshots?.length || 0) + (videos?.length || 0) + (traces?.length || 0) + (other?.length || 0),
        screenshots: screenshots?.length || 0,
        videos: videos?.length || 0,
        traces: traces?.length || 0
    };
}
