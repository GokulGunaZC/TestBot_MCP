/**
 * TestBot Configuration Form Handler
 * Handles multi-step form, validation, and submission
 */

// State
let currentStep = 1;
const totalSteps = 4;
let projectConfig = {};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    loadSavedData();
    setupEventListeners();
    loadProjectInfo();
});

/**
 * Load project info from URL params or server
 */
function loadProjectInfo() {
    const params = new URLSearchParams(window.location.search);
    
    projectConfig = {
        projectPath: params.get('projectPath') || '',
        projectName: params.get('projectName') || 'Project',
        framework: params.get('framework') || 'auto',
        baseURL: params.get('baseURL') || 'http://localhost:3000',
        port: params.get('port') || '3000',
        startCommand: params.get('startCommand') || 'npm run dev',
        serverPort: params.get('serverPort') || '54321',
    };
    
    // Update UI
    document.getElementById('projectName').textContent = projectConfig.projectName;
    document.getElementById('projectPath').value = projectConfig.projectPath;
    document.getElementById('framework').value = projectConfig.framework;
    document.getElementById('baseURL').value = projectConfig.baseURL;
    document.getElementById('port').value = projectConfig.port;
    document.getElementById('startCommand').value = projectConfig.startCommand;
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Form submission
    document.getElementById('configForm').addEventListener('submit', handleSubmit);
    
    // PRD tabs
    document.querySelectorAll('.prd-tab').forEach(tab => {
        tab.addEventListener('click', () => switchPRDTab(tab.dataset.tab));
    });
    
    // Auto-save on input
    document.querySelectorAll('input, textarea, select').forEach(input => {
        input.addEventListener('change', saveFormData);
        input.addEventListener('input', debounce(saveFormData, 1000));
    });
    
    // PRD preview update
    document.getElementById('prd').addEventListener('input', debounce(updatePRDPreview, 500));
}

/**
 * Navigate to next step
 */
function nextStep() {
    if (currentStep < totalSteps) {
        // Validate current step
        if (!validateStep(currentStep)) {
            return;
        }
        
        // Update UI
        document.querySelector(`.form-section[data-section="${currentStep}"]`).classList.remove('active');
        document.querySelector(`.step[data-step="${currentStep}"]`).classList.add('completed');
        
        currentStep++;
        
        document.querySelector(`.form-section[data-section="${currentStep}"]`).classList.add('active');
        document.querySelector(`.step[data-step="${currentStep}"]`).classList.add('active');
        
        // Update summary on last step
        if (currentStep === 4) {
            updateSummary();
        }
        
        // Scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

/**
 * Navigate to previous step
 */
function prevStep() {
    if (currentStep > 1) {
        document.querySelector(`.form-section[data-section="${currentStep}"]`).classList.remove('active');
        document.querySelector(`.step[data-step="${currentStep}"]`).classList.remove('active');
        
        currentStep--;
        
        document.querySelector(`.form-section[data-section="${currentStep}"]`).classList.add('active');
        document.querySelector(`.step[data-step="${currentStep}"]`).classList.remove('completed');
        
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

/**
 * Validate current step
 */
function validateStep(step) {
    switch (step) {
        case 1:
            const baseURL = document.getElementById('baseURL').value;
            if (!baseURL) {
                alert('Please enter a Base URL');
                return false;
            }
            return true;
        case 2:
            // PRD is optional but recommended
            return true;
        case 3:
            return true;
        default:
            return true;
    }
}

/**
 * Update summary on step 4
 */
function updateSummary() {
    const formData = getFormData();
    
    document.getElementById('summaryProject').textContent = projectConfig.projectName || 'Unknown';
    document.getElementById('summaryFramework').textContent = 
        document.getElementById('framework').options[document.getElementById('framework').selectedIndex].text;
    document.getElementById('summaryBaseURL').textContent = formData.baseURL || '-';
    document.getElementById('summaryTestType').textContent = formData.testType.charAt(0).toUpperCase() + formData.testType.slice(1);
    document.getElementById('summaryPRDLength').textContent = `${(formData.prd || '').length} characters`;
}

/**
 * Handle form submission
 */
async function handleSubmit(e) {
    e.preventDefault();
    
    const formData = getFormData();
    const generatingIndicator = document.getElementById('generatingIndicator');
    const successMessage = document.getElementById('successMessage');
    const errorMessage = document.getElementById('errorMessage');
    const generateActions = document.getElementById('generateActions');
    
    // Show generating state
    generatingIndicator.style.display = 'flex';
    generateActions.style.display = 'none';
    errorMessage.style.display = 'none';
    
    try {
        // Update status
        updateGeneratingStatus('Gathering codebase context...');
        await delay(500);
        
        updateGeneratingStatus('Analyzing project structure...');
        await delay(500);
        
        updateGeneratingStatus('Generating tests with OpenAI...');
        
        // Submit to server
        const serverPort = projectConfig.serverPort || '54321';
        const response = await fetch(`http://localhost:${serverPort}/api/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                ...formData,
                projectPath: projectConfig.projectPath,
                projectName: projectConfig.projectName,
            }),
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Server error');
        }
        
        const result = await response.json();
        
        // Clear saved data on success
        localStorage.removeItem('testbot_config_form');
        
        // Show success
        generatingIndicator.style.display = 'none';
        successMessage.style.display = 'flex';
        
        // Close window after delay (server will proceed with test generation)
        setTimeout(() => {
            window.close();
        }, 2000);
        
    } catch (error) {
        console.error('Submission error:', error);
        generatingIndicator.style.display = 'none';
        errorMessage.style.display = 'flex';
        document.getElementById('errorText').textContent = error.message || 'An unexpected error occurred';
        generateActions.style.display = 'flex';
    }
}

/**
 * Update generating status text
 */
function updateGeneratingStatus(text) {
    document.getElementById('generatingStatus').textContent = text;
}

/**
 * Get form data
 */
function getFormData() {
    const form = document.getElementById('configForm');
    const formData = new FormData(form);
    
    const data = {
        projectPath: document.getElementById('projectPath').value,
        framework: document.getElementById('framework').value,
        baseURL: document.getElementById('baseURL').value,
        port: document.getElementById('port').value,
        startCommand: document.getElementById('startCommand').value,
        prd: document.getElementById('prd').value,
        testType: formData.get('testType') || 'frontend',
        includeSmoke: formData.get('includeSmoke') === 'on',
        includeWorkflows: formData.get('includeWorkflows') === 'on',
        includeAccessibility: formData.get('includeAccessibility') === 'on',
        includeErrorStates: formData.get('includeErrorStates') === 'on',
        priorityFeatures: document.getElementById('priorityFeatures').value,
    };
    
    return data;
}

/**
 * Switch PRD tabs
 */
function switchPRDTab(tab) {
    document.querySelectorAll('.prd-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.prd-tab[data-tab="${tab}"]`).classList.add('active');
    
    const textarea = document.getElementById('prd');
    const preview = document.getElementById('prdPreview');
    
    if (tab === 'edit') {
        textarea.style.display = 'block';
        preview.style.display = 'none';
    } else {
        textarea.style.display = 'none';
        preview.style.display = 'block';
        updatePRDPreview();
    }
}

/**
 * Update PRD preview (simple markdown conversion)
 */
function updatePRDPreview() {
    const prd = document.getElementById('prd').value;
    const preview = document.getElementById('prdPreview');
    
    // Simple markdown conversion
    let html = prd
        .replace(/^### (.*$)/gm, '<h3>$1</h3>')
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')
        .replace(/^\* (.*$)/gm, '<li>$1</li>')
        .replace(/^- (.*$)/gm, '<li>$1</li>')
        .replace(/^\d+\. (.*$)/gm, '<li>$1</li>')
        .replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
    
    preview.innerHTML = `<p>${html}</p>`;
}

/**
 * Load PRD template
 */
function loadTemplate(type) {
    const templates = {
        ecommerce: `# E-commerce Application

## Overview
Online shopping platform with product catalog, cart, and checkout.

## User Flows
1. **Authentication**
   - User registration with email verification
   - Login with remember me option
   - Password reset flow

2. **Product Browsing**
   - Homepage with featured products
   - Category-based navigation
   - Search with filters (price, rating, category)
   - Product detail page with images, reviews

3. **Shopping Cart**
   - Add/remove items
   - Quantity adjustment
   - Price calculation with discounts
   - Persistent cart across sessions

4. **Checkout**
   - Shipping address form
   - Payment method selection
   - Order summary
   - Order confirmation

## Critical Paths
- Complete purchase flow from product to confirmation
- Cart should persist across page refreshes
- Form validation for all user inputs`,

        dashboard: `# Dashboard Application

## Overview
Analytics dashboard with data visualization and user management.

## User Flows
1. **Authentication**
   - Login with email/password
   - Session management
   - Role-based access control

2. **Dashboard Views**
   - Overview with key metrics
   - Charts and graphs
   - Date range filtering
   - Data export functionality

3. **User Management** (Admin)
   - User listing with search
   - Create/edit user profiles
   - Role assignment
   - Activity logs

## Critical Paths
- Dashboard should load within 3 seconds
- Charts should render with correct data
- Role-based features should be properly restricted`,

        saas: `# SaaS Application

## Overview
Multi-tenant SaaS platform with subscription management.

## User Flows
1. **Onboarding**
   - Sign up with organization
   - Email verification
   - Initial setup wizard
   - Plan selection

2. **Core Features**
   - Main application workflow
   - Team collaboration
   - Settings management
   - Notifications

3. **Billing**
   - Subscription management
   - Plan upgrades/downgrades
   - Payment method updates
   - Invoice history

## Critical Paths
- New user should complete onboarding in under 5 minutes
- Subscription changes should reflect immediately
- Data isolation between tenants`,

        api: `# API Backend

## Overview
RESTful API backend with authentication and CRUD operations.

## API Endpoints
1. **Authentication**
   - POST /api/auth/login
   - POST /api/auth/register
   - POST /api/auth/refresh
   - POST /api/auth/logout

2. **Users**
   - GET /api/users
   - GET /api/users/:id
   - POST /api/users
   - PUT /api/users/:id
   - DELETE /api/users/:id

3. **Resources**
   - Full CRUD for main resources
   - Pagination support
   - Filtering and sorting
   - Bulk operations

## Critical Tests
- Authentication should return proper tokens
- Protected routes should require valid auth
- CRUD operations should validate input
- Error responses should follow consistent format`,
    };
    
    const template = templates[type];
    if (template) {
        document.getElementById('prd').value = template;
        updatePRDPreview();
        saveFormData();
    }
}

/**
 * Save form data to localStorage
 */
function saveFormData() {
    const data = getFormData();
    localStorage.setItem('testbot_config_form', JSON.stringify(data));
}

/**
 * Load saved form data
 */
function loadSavedData() {
    const saved = localStorage.getItem('testbot_config_form');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            
            if (data.prd) document.getElementById('prd').value = data.prd;
            if (data.priorityFeatures) document.getElementById('priorityFeatures').value = data.priorityFeatures;
            
            // Restore checkboxes
            if (data.includeSmoke !== undefined) {
                document.querySelector('[name="includeSmoke"]').checked = data.includeSmoke;
            }
            if (data.includeWorkflows !== undefined) {
                document.querySelector('[name="includeWorkflows"]').checked = data.includeWorkflows;
            }
            if (data.includeAccessibility !== undefined) {
                document.querySelector('[name="includeAccessibility"]').checked = data.includeAccessibility;
            }
            if (data.includeErrorStates !== undefined) {
                document.querySelector('[name="includeErrorStates"]').checked = data.includeErrorStates;
            }
            
            // Restore test type
            if (data.testType) {
                const radio = document.querySelector(`[name="testType"][value="${data.testType}"]`);
                if (radio) radio.checked = true;
            }
        } catch (e) {
            console.error('Failed to load saved form data:', e);
        }
    }
}

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
 * Utility: Delay promise
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
