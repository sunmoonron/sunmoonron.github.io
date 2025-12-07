/**
 * UI Module - Renders skating program data
 * Modular components for easy maintenance
 */

const SkateUI = {
    // DOM element references
    elements: {},
    
    // Current state
    state: {
        programs: [],
        filteredPrograms: [],
        currentView: 'cards', // 'cards', 'list', 'calendar'
        currentPage: 1,
        perPage: 20,
        sortBy: 'date',
        sortAsc: true,
        filters: {}
    },
    
    /**
     * Initialize UI with DOM elements
     */
    init(containerSelector = '#skate-app') {
        this.elements.container = document.querySelector(containerSelector);
        if (!this.elements.container) {
            console.error('[SkateUI] Container not found:', containerSelector);
            return;
        }
        
        this.render();
        this.bindEvents();
    },
    
    /**
     * Main render function
     */
    render() {
        this.elements.container.innerHTML = `
            <div class="skate-app">
                <header class="skate-header">
                    <h1>🛼 Toronto Drop-in Skating</h1>
                    <p class="subtitle">Find skating, shinny & hockey near you</p>
                    <div class="cache-status" id="cache-status"></div>
                </header>
                
                <div class="skate-controls">
                    <div class="search-bar">
                        <input type="text" id="search-input" placeholder="Search activities, locations..." />
                        <button id="search-btn" class="btn btn-primary">Search</button>
                    </div>
                    
                    <div class="quick-filters" id="quick-filters">
                        <button class="filter-chip active" data-filter="all">All Skating</button>
                        <button class="filter-chip" data-filter="leisure">Leisure Skate</button>
                        <button class="filter-chip" data-filter="shinny">Shinny</button>
                        <button class="filter-chip" data-filter="figure">Figure Skating</button>
                        <button class="filter-chip" data-filter="speed">Speed Skating</button>
                    </div>
                    
                    <div class="advanced-filters" id="advanced-filters">
                        <button class="btn btn-secondary" id="toggle-filters">
                            <span>⚙️ Filters</span>
                            <span class="filter-count" id="filter-count"></span>
                        </button>
                        
                        <div class="filter-panel hidden" id="filter-panel">
                            <div class="filter-group">
                                <label>Day of Week</label>
                                <div class="day-buttons" id="day-filters"></div>
                            </div>
                            
                            <div class="filter-group">
                                <label>Age</label>
                                <input type="number" id="age-filter" placeholder="Your age" min="0" max="120" />
                            </div>
                            
                            <div class="filter-group">
                                <label>Time Range</label>
                                <div class="time-range">
                                    <input type="time" id="time-start" />
                                    <span>to</span>
                                    <input type="time" id="time-end" />
                                </div>
                            </div>
                            
                            <div class="filter-group">
                                <label>Location</label>
                                <select id="location-filter" multiple>
                                    <option value="">All Locations</option>
                                </select>
                            </div>
                            
                            <div class="filter-actions">
                                <button class="btn btn-secondary" id="clear-filters">Clear</button>
                                <button class="btn btn-primary" id="apply-filters">Apply</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="view-controls">
                        <button class="view-btn active" data-view="cards" title="Card View">🃏</button>
                        <button class="view-btn" data-view="list" title="List View">📋</button>
                        <button class="view-btn" data-view="calendar" title="Calendar View">📅</button>
                    </div>
                </div>
                
                <div class="skate-stats" id="stats-bar">
                    <span class="stat">Loading...</span>
                </div>
                
                <main class="skate-content" id="content-area">
                    <div class="loading-spinner">
                        <div class="spinner"></div>
                        <p>Loading skating programs...</p>
                    </div>
                </main>
                
                <div class="pagination" id="pagination"></div>
                
                <footer class="skate-footer">
                    <p>Data from <a href="https://open.toronto.ca" target="_blank">City of Toronto Open Data</a></p>
                    <p>Updates daily at 8:00 AM EST</p>
                    <button class="btn btn-link" id="refresh-data">↻ Refresh Data</button>
                </footer>
            </div>
        `;
        
        // Cache element references
        this.elements.searchInput = document.getElementById('search-input');
        this.elements.contentArea = document.getElementById('content-area');
        this.elements.pagination = document.getElementById('pagination');
        this.elements.statsBar = document.getElementById('stats-bar');
        this.elements.cacheStatus = document.getElementById('cache-status');
        this.elements.filterPanel = document.getElementById('filter-panel');
        this.elements.locationFilter = document.getElementById('location-filter');
        this.elements.dayFilters = document.getElementById('day-filters');
    },
    
    /**
     * Bind event listeners
     */
    bindEvents() {
        // Search
        document.getElementById('search-btn')?.addEventListener('click', () => this.handleSearch());
        this.elements.searchInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleSearch();
        });
        
        // Quick filters
        document.getElementById('quick-filters')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('filter-chip')) {
                document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                this.handleQuickFilter(e.target.dataset.filter);
            }
        });
        
        // Toggle advanced filters
        document.getElementById('toggle-filters')?.addEventListener('click', () => {
            this.elements.filterPanel?.classList.toggle('hidden');
        });
        
        // Apply filters
        document.getElementById('apply-filters')?.addEventListener('click', () => this.applyFilters());
        document.getElementById('clear-filters')?.addEventListener('click', () => this.clearFilters());
        
        // View toggle
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.state.currentView = e.target.dataset.view;
                this.renderPrograms();
            });
        });
        
        // Refresh data
        document.getElementById('refresh-data')?.addEventListener('click', () => this.refreshData());
    },
    
    /**
     * Update programs and render
     */
    setPrograms(programs) {
        this.state.programs = programs;
        this.state.filteredPrograms = programs;
        SkateFilters.clearCache();
        this.populateFilterOptions();
        this.updateStats();
        this.renderPrograms();
    },
    
    /**
     * Populate filter dropdowns
     */
    populateFilterOptions() {
        const options = SkateFilters.getFilterOptions(this.state.programs);
        
        // Populate location select
        if (this.elements.locationFilter) {
            this.elements.locationFilter.innerHTML = options.locations
                .map(loc => `<option value="${loc}">${loc}</option>`)
                .join('');
        }
        
        // Populate day buttons
        if (this.elements.dayFilters) {
            this.elements.dayFilters.innerHTML = options.days
                .map(day => `<button class="day-btn" data-day="${day}">${day.slice(0, 3)}</button>`)
                .join('');
                
            this.elements.dayFilters.addEventListener('click', (e) => {
                if (e.target.classList.contains('day-btn')) {
                    e.target.classList.toggle('active');
                }
            });
        }
    },
    
    /**
     * Handle search
     */
    handleSearch() {
        const term = this.elements.searchInput?.value || '';
        this.state.filters.searchTerm = term;
        this.applyFilters();
    },
    
    /**
     * Handle quick filter clicks
     */
    handleQuickFilter(filter) {
        let activityFilter = [];
        
        switch (filter) {
            case 'leisure':
                activityFilter = this.state.programs
                    .filter(p => (p.Activity || p['Activity Title'] || '').toLowerCase().includes('leisure'))
                    .map(p => p.Activity || p['Activity Title']);
                break;
            case 'shinny':
                activityFilter = this.state.programs
                    .filter(p => (p.Activity || p['Activity Title'] || '').toLowerCase().includes('shinny'))
                    .map(p => p.Activity || p['Activity Title']);
                break;
            case 'figure':
                activityFilter = this.state.programs
                    .filter(p => (p.Activity || p['Activity Title'] || '').toLowerCase().includes('figure'))
                    .map(p => p.Activity || p['Activity Title']);
                break;
            case 'speed':
                activityFilter = this.state.programs
                    .filter(p => (p.Activity || p['Activity Title'] || '').toLowerCase().includes('speed'))
                    .map(p => p.Activity || p['Activity Title']);
                break;
            default:
                activityFilter = [];
        }
        
        this.state.filters.activity = [...new Set(activityFilter)];
        this.applyFilters();
    },
    
    /**
     * Apply current filters
     */
    applyFilters() {
        // Gather filter values
        const age = document.getElementById('age-filter')?.value;
        const timeStart = document.getElementById('time-start')?.value;
        const timeEnd = document.getElementById('time-end')?.value;
        const selectedDays = [...document.querySelectorAll('.day-btn.active')]
            .map(btn => btn.dataset.day);
        const selectedLocations = [...(document.getElementById('location-filter')?.selectedOptions || [])]
            .map(opt => opt.value)
            .filter(v => v);
        
        const criteria = {
            ...this.state.filters,
            age: age ? parseInt(age) : null,
            timeRange: (timeStart && timeEnd) ? { start: timeStart, end: timeEnd } : null,
            day: selectedDays.length > 0 ? selectedDays : null,
            location: selectedLocations.length > 0 ? selectedLocations : null,
            upcoming: true
        };
        
        this.state.filteredPrograms = SkateFilters.filter(this.state.programs, criteria);
        this.state.filteredPrograms = SkateFilters.sort(
            this.state.filteredPrograms, 
            this.state.sortBy, 
            this.state.sortAsc
        );
        
        this.state.currentPage = 1;
        this.updateStats();
        this.renderPrograms();
        this.updateFilterCount();
    },
    
    /**
     * Clear all filters
     */
    clearFilters() {
        this.state.filters = {};
        document.getElementById('age-filter').value = '';
        document.getElementById('time-start').value = '';
        document.getElementById('time-end').value = '';
        document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('location-filter').selectedIndex = -1;
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        document.querySelector('[data-filter="all"]')?.classList.add('active');
        
        this.state.filteredPrograms = this.state.programs;
        this.state.currentPage = 1;
        this.updateStats();
        this.renderPrograms();
        this.updateFilterCount();
    },
    
    /**
     * Update filter count badge
     */
    updateFilterCount() {
        const count = Object.values(this.state.filters).filter(v => v && v.length > 0).length;
        const badge = document.getElementById('filter-count');
        if (badge) {
            badge.textContent = count > 0 ? count : '';
            badge.style.display = count > 0 ? 'inline' : 'none';
        }
    },
    
    /**
     * Update stats bar
     */
    updateStats() {
        const total = this.state.programs.length;
        const filtered = this.state.filteredPrograms.length;
        const thisWeek = SkateFilters.filter(this.state.filteredPrograms, { 
            dateRange: { 
                start: new Date(), 
                end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) 
            }
        }).length;
        
        this.elements.statsBar.innerHTML = `
            <span class="stat"><strong>${filtered}</strong> programs${filtered !== total ? ` (of ${total})` : ''}</span>
            <span class="stat"><strong>${thisWeek}</strong> this week</span>
        `;
    },
    
    /**
     * Render programs based on current view
     */
    renderPrograms() {
        const { filteredPrograms, currentView, currentPage, perPage } = this.state;
        
        if (filteredPrograms.length === 0) {
            this.elements.contentArea.innerHTML = `
                <div class="no-results">
                    <span class="emoji">🛼</span>
                    <h3>No skating programs found</h3>
                    <p>Try adjusting your filters or search term</p>
                </div>
            `;
            this.elements.pagination.innerHTML = '';
            return;
        }
        
        const startIdx = (currentPage - 1) * perPage;
        const pagePrograms = filteredPrograms.slice(startIdx, startIdx + perPage);
        
        switch (currentView) {
            case 'list':
                this.renderListView(pagePrograms);
                break;
            case 'calendar':
                this.renderCalendarView(pagePrograms);
                break;
            default:
                this.renderCardView(pagePrograms);
        }
        
        this.renderPagination();
    },
    
    /**
     * Render card view
     */
    renderCardView(programs) {
        this.elements.contentArea.innerHTML = `
            <div class="program-cards">
                ${programs.map(p => this.renderCard(p)).join('')}
            </div>
        `;
    },
    
    /**
     * Render a single program card
     */
    renderCard(program) {
        const activity = program.Activity || program['Activity Title'] || 'Unknown Activity';
        const location = program.LocationName || program['Location Name'] || 'Unknown Location';
        const startDate = program['Start Date Time'] || program['Start Date'] || '';
        const startTime = program['Start Time'] || '';
        const endTime = program['End Time'] || '';
        const day = program['Day of Week'] || '';
        const ageMin = program['Age Min'];
        const ageMax = program['Age Max'];
        const facility = program.FacilityType || program['Facility Type'] || '';
        
        const dateDisplay = startDate ? new Date(startDate).toLocaleDateString('en-CA', {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        }) : day;
        
        const ageDisplay = SkateFilters.formatAgeRange(ageMin, ageMax) || 'All Ages';
        
        // Activity type styling
        const activityLower = activity.toLowerCase();
        let typeClass = 'leisure';
        if (activityLower.includes('shinny')) typeClass = 'shinny';
        else if (activityLower.includes('figure')) typeClass = 'figure';
        else if (activityLower.includes('speed')) typeClass = 'speed';
        else if (activityLower.includes('stick') || activityLower.includes('puck')) typeClass = 'shinny';
        
        return `
            <div class="program-card ${typeClass}">
                <div class="card-header">
                    <span class="activity-type">${this.getActivityIcon(activity)} ${this.getActivityType(activity)}</span>
                    <span class="facility-badge">${facility}</span>
                </div>
                <h3 class="card-title">${activity}</h3>
                <div class="card-location">📍 ${location}</div>
                <div class="card-details">
                    <div class="detail">
                        <span class="icon">📅</span>
                        <span>${dateDisplay}</span>
                    </div>
                    <div class="detail">
                        <span class="icon">⏰</span>
                        <span>${startTime}${endTime ? ` - ${endTime}` : ''}</span>
                    </div>
                    <div class="detail">
                        <span class="icon">👤</span>
                        <span>${ageDisplay}</span>
                    </div>
                </div>
            </div>
        `;
    },
    
    /**
     * Get icon for activity type
     */
    getActivityIcon(activity) {
        const lower = activity.toLowerCase();
        if (lower.includes('shinny') || lower.includes('hockey') || lower.includes('stick')) return '🏒';
        if (lower.includes('figure')) return '⛸️';
        if (lower.includes('speed')) return '🏃';
        if (lower.includes('ringette')) return '🥏';
        return '🛼';
    },
    
    /**
     * Get simplified activity type
     */
    getActivityType(activity) {
        const lower = activity.toLowerCase();
        if (lower.includes('shinny')) return 'Shinny';
        if (lower.includes('figure')) return 'Figure';
        if (lower.includes('speed')) return 'Speed';
        if (lower.includes('stick') || lower.includes('puck')) return 'Hockey';
        if (lower.includes('ringette')) return 'Ringette';
        return 'Leisure';
    },
    
    /**
     * Render list view
     */
    renderListView(programs) {
        this.elements.contentArea.innerHTML = `
            <table class="program-table">
                <thead>
                    <tr>
                        <th>Activity</th>
                        <th>Location</th>
                        <th>Date</th>
                        <th>Time</th>
                        <th>Age</th>
                        <th>Facility</th>
                    </tr>
                </thead>
                <tbody>
                    ${programs.map(p => this.renderTableRow(p)).join('')}
                </tbody>
            </table>
        `;
    },
    
    /**
     * Render table row
     */
    renderTableRow(program) {
        const activity = program.Activity || program['Activity Title'] || 'Unknown';
        const location = program.LocationName || program['Location Name'] || 'Unknown';
        const startDate = program['Start Date Time'] || program['Start Date'] || '';
        const startTime = program['Start Time'] || '';
        const endTime = program['End Time'] || '';
        const ageMin = program['Age Min'];
        const ageMax = program['Age Max'];
        const facility = program.FacilityType || program['Facility Type'] || '';
        
        const dateDisplay = startDate ? new Date(startDate).toLocaleDateString('en-CA', {
            month: 'short', day: 'numeric'
        }) : '';
        
        const ageDisplay = SkateFilters.formatAgeRange(ageMin, ageMax) || 'All';
        
        return `
            <tr>
                <td><strong>${activity}</strong></td>
                <td>${location}</td>
                <td>${dateDisplay}</td>
                <td>${startTime}${endTime ? ` - ${endTime}` : ''}</td>
                <td>${ageDisplay}</td>
                <td>${facility}</td>
            </tr>
        `;
    },
    
    /**
     * Render calendar view
     */
    renderCalendarView(programs) {
        const grouped = SkateFilters.groupBy(programs, 'Day of Week');
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        
        this.elements.contentArea.innerHTML = `
            <div class="calendar-view">
                ${days.map(day => `
                    <div class="calendar-day">
                        <h4>${day}</h4>
                        <div class="day-programs">
                            ${(grouped[day] || []).slice(0, 5).map(p => `
                                <div class="mini-card">
                                    <span class="time">${p['Start Time'] || ''}</span>
                                    <span class="name">${p.Activity || p['Activity Title'] || ''}</span>
                                </div>
                            `).join('')}
                            ${(grouped[day] || []).length > 5 ? 
                                `<div class="more">+${grouped[day].length - 5} more</div>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    },
    
    /**
     * Render pagination
     */
    renderPagination() {
        const { filteredPrograms, currentPage, perPage } = this.state;
        const totalPages = Math.ceil(filteredPrograms.length / perPage);
        
        if (totalPages <= 1) {
            this.elements.pagination.innerHTML = '';
            return;
        }
        
        let buttons = '';
        
        // Previous button
        buttons += `<button class="page-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">←</button>`;
        
        // Page numbers
        const start = Math.max(1, currentPage - 2);
        const end = Math.min(totalPages, currentPage + 2);
        
        if (start > 1) {
            buttons += `<button class="page-btn" data-page="1">1</button>`;
            if (start > 2) buttons += `<span class="page-dots">...</span>`;
        }
        
        for (let i = start; i <= end; i++) {
            buttons += `<button class="page-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        }
        
        if (end < totalPages) {
            if (end < totalPages - 1) buttons += `<span class="page-dots">...</span>`;
            buttons += `<button class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
        }
        
        // Next button
        buttons += `<button class="page-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">→</button>`;
        
        this.elements.pagination.innerHTML = buttons;
        
        // Bind pagination events
        this.elements.pagination.querySelectorAll('.page-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const page = parseInt(e.target.dataset.page);
                if (!isNaN(page) && page >= 1 && page <= totalPages) {
                    this.state.currentPage = page;
                    this.renderPrograms();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            });
        });
    },
    
    /**
     * Show loading state
     */
    showLoading(message = 'Loading...') {
        this.elements.contentArea.innerHTML = `
            <div class="loading-spinner">
                <div class="spinner"></div>
                <p>${message}</p>
            </div>
        `;
    },
    
    /**
     * Show error state
     */
    showError(message) {
        this.elements.contentArea.innerHTML = `
            <div class="error-message">
                <span class="emoji">❌</span>
                <h3>Error</h3>
                <p>${message}</p>
                <button class="btn btn-primary" id="retry-btn">Retry</button>
            </div>
        `;
        
        document.getElementById('retry-btn')?.addEventListener('click', () => this.refreshData());
    },
    
    /**
     * Update cache status display
     */
    updateCacheStatus() {
        const meta = SkateAPI.getMetadata();
        
        let statusText = '';
        if (meta?.lastUpdated) {
            const lastUpdate = new Date(meta.lastUpdated);
            const daysAgo = Math.floor((Date.now() - lastUpdate) / (1000 * 60 * 60 * 24));
            statusText = `Data from: ${lastUpdate.toLocaleDateString('en-CA')}`;
            if (daysAgo > 7) {
                statusText += ' ⚠️ (Run fetch-skate-data.js to update)';
            }
            if (meta.counts) {
                statusText += ` | ${meta.counts.skatingPrograms.toLocaleString()} programs`;
            }
        } else {
            statusText = 'Loading data...';
        }
        
        this.elements.cacheStatus.textContent = statusText;
    },
    
    /**
     * Refresh data - reloads from static JSON files
     * Note: To get fresh data from City of Toronto, run: node fetch-skate-data.js
     */
    async refreshData() {
        // Clear memory cache to force reload from file
        SkateAPI.clearCache();
        this.showLoading('Reloading skating data...');
        
        try {
            const programs = await SkateAPI.getSkatingPrograms();
            this.setPrograms(programs);
            this.updateCacheStatus();
        } catch (error) {
            this.showError(error.message || 'Failed to load data. Please try again.');
            console.error(error);
        }
    }
};

// Export for ES modules
if (typeof window !== 'undefined') {
    window.SkateUI = SkateUI;
}
