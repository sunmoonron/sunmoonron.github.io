/**
 * Filters Module - Smart filtering and searching
 * Provides efficient client-side filtering for the skating data
 */

const SkateFilters = {
    // Cache for computed filter options
    filterOptionsCache: null,
    
    /**
     * Parse date string to Date object
     * Handles formats like "Sunday December 7th" or ISO dates
     */
    parseDate(dateStr) {
        if (!dateStr) return null;
        
        // If already a date-like string with year
        if (dateStr.includes('-') || dateStr.includes('/')) {
            return new Date(dateStr);
        }
        
        // Handle "Weekday Month Dayth" format - assume current year
        // The City data uses "Start Date Time" field
        try {
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                return date;
            }
        } catch (e) {}
        
        return null;
    },
    
    /**
     * Parse time string to minutes since midnight
     */
    parseTime(timeStr) {
        if (!timeStr) return null;
        
        // Handle "HH:MM AM/PM" format
        const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
        if (!match) return null;
        
        let hours = parseInt(match[1]);
        const mins = parseInt(match[2]);
        const period = match[3];
        
        if (period) {
            if (period.toUpperCase() === 'PM' && hours !== 12) hours += 12;
            if (period.toUpperCase() === 'AM' && hours === 12) hours = 0;
        }
        
        return hours * 60 + mins;
    },
    
    /**
     * Extract unique filter options from programs
     */
    getFilterOptions(programs) {
        if (this.filterOptionsCache) {
            return this.filterOptionsCache;
        }
        
        const activities = new Set();
        const locations = new Set();
        const ageGroups = new Set();
        const days = new Set();
        const facilities = new Set();
        
        programs.forEach(p => {
            if (p.Activity || p['Activity Title']) {
                activities.add(p.Activity || p['Activity Title']);
            }
            if (p.LocationName || p['Location Name']) {
                locations.add(p.LocationName || p['Location Name']);
            }
            if (p['Age Min'] !== undefined || p['Age Max'] !== undefined) {
                const ageStr = this.formatAgeRange(p['Age Min'], p['Age Max']);
                if (ageStr) ageGroups.add(ageStr);
            }
            if (p['Day of Week']) {
                days.add(p['Day of Week']);
            }
            if (p.FacilityType || p['Facility Type']) {
                facilities.add(p.FacilityType || p['Facility Type']);
            }
        });
        
        this.filterOptionsCache = {
            activities: [...activities].sort(),
            locations: [...locations].sort(),
            ageGroups: [...ageGroups].sort(),
            days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
                .filter(d => days.has(d)),
            facilities: [...facilities].sort()
        };
        
        return this.filterOptionsCache;
    },
    
    /**
     * Format age range for display
     */
    formatAgeRange(min, max) {
        if (min === undefined && max === undefined) return null;
        if (min === 0 && max === 999) return 'All Ages';
        if (min === 0 && max) return `0 - ${max} years`;
        if (min && max === 999) return `${min}+ years`;
        if (min && max) return `${min} - ${max} years`;
        return null;
    },
    
    /**
     * Check if a program matches age filter
     */
    matchesAge(program, targetAge) {
        if (!targetAge) return true;
        
        const min = program['Age Min'] || 0;
        const max = program['Age Max'] || 999;
        
        return targetAge >= min && targetAge <= max;
    },
    
    /**
     * Check if a program is happening today or in the future
     */
    isUpcoming(program) {
        const startDate = program['Start Date Time'] || program['Start Date'];
        if (!startDate) return true; // Include if no date
        
        const programDate = new Date(startDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        return programDate >= today;
    },
    
    /**
     * Check if a program is happening this week
     */
    isThisWeek(program) {
        const startDate = program['Start Date Time'] || program['Start Date'];
        if (!startDate) return false;
        
        const programDate = new Date(startDate);
        const today = new Date();
        const weekFromNow = new Date();
        weekFromNow.setDate(weekFromNow.getDate() + 7);
        
        return programDate >= today && programDate <= weekFromNow;
    },
    
    /**
     * Main filter function
     * @param {Array} programs - All programs
     * @param {Object} criteria - Filter criteria
     */
    filter(programs, criteria = {}) {
        const {
            activity = null,
            location = null,
            day = null,
            age = null,
            timeRange = null, // { start: 'HH:MM', end: 'HH:MM' }
            searchTerm = null,
            dateRange = null, // { start: Date, end: Date }
            upcoming = true,
            facilityType = null
        } = criteria;
        
        return programs.filter(p => {
            // Activity filter
            if (activity && activity.length > 0) {
                const pActivity = p.Activity || p['Activity Title'] || '';
                if (!activity.includes(pActivity)) return false;
            }
            
            // Location filter
            if (location && location.length > 0) {
                const pLocation = p.LocationName || p['Location Name'] || '';
                if (!location.includes(pLocation)) return false;
            }
            
            // Day filter
            if (day && day.length > 0) {
                const pDay = p['Day of Week'] || '';
                if (!day.includes(pDay)) return false;
            }
            
            // Age filter
            if (age !== null) {
                if (!this.matchesAge(p, age)) return false;
            }
            
            // Time range filter
            if (timeRange) {
                const startTime = p['Start Time'] || '';
                const programStart = this.parseTime(startTime);
                const rangeStart = this.parseTime(timeRange.start);
                const rangeEnd = this.parseTime(timeRange.end);
                
                if (programStart !== null && rangeStart !== null && rangeEnd !== null) {
                    if (programStart < rangeStart || programStart > rangeEnd) return false;
                }
            }
            
            // Date range filter
            if (dateRange) {
                const startDate = p['Start Date Time'] || p['Start Date'];
                if (startDate) {
                    const programDate = new Date(startDate);
                    if (dateRange.start && programDate < dateRange.start) return false;
                    if (dateRange.end && programDate > dateRange.end) return false;
                }
            }
            
            // Upcoming only filter
            if (upcoming && !this.isUpcoming(p)) return false;
            
            // Facility type filter
            if (facilityType) {
                const pFacility = p.FacilityType || p['Facility Type'] || '';
                if (pFacility !== facilityType) return false;
            }
            
            // Search term filter (searches multiple fields)
            if (searchTerm) {
                const term = searchTerm.toLowerCase();
                const searchFields = [
                    p.Activity || p['Activity Title'] || '',
                    p.LocationName || p['Location Name'] || '',
                    p.Category || '',
                    p['Facility Type'] || p.FacilityType || ''
                ];
                
                const matchesSearch = searchFields.some(field => 
                    field.toLowerCase().includes(term)
                );
                
                if (!matchesSearch) return false;
            }
            
            return true;
        });
    },
    
    /**
     * Sort programs by various criteria
     */
    sort(programs, sortBy = 'date', ascending = true) {
        const sorted = [...programs].sort((a, b) => {
            let valA, valB;
            
            switch (sortBy) {
                case 'date':
                    valA = new Date(a['Start Date Time'] || a['Start Date'] || 0);
                    valB = new Date(b['Start Date Time'] || b['Start Date'] || 0);
                    break;
                case 'time':
                    valA = this.parseTime(a['Start Time']) || 0;
                    valB = this.parseTime(b['Start Time']) || 0;
                    break;
                case 'activity':
                    valA = a.Activity || a['Activity Title'] || '';
                    valB = b.Activity || b['Activity Title'] || '';
                    break;
                case 'location':
                    valA = a.LocationName || a['Location Name'] || '';
                    valB = b.LocationName || b['Location Name'] || '';
                    break;
                default:
                    return 0;
            }
            
            if (typeof valA === 'string') {
                return ascending ? valA.localeCompare(valB) : valB.localeCompare(valA);
            }
            return ascending ? valA - valB : valB - valA;
        });
        
        return sorted;
    },
    
    /**
     * Group programs by a field
     */
    groupBy(programs, field) {
        const groups = {};
        
        programs.forEach(p => {
            const key = p[field] || 'Unknown';
            if (!groups[key]) {
                groups[key] = [];
            }
            groups[key].push(p);
        });
        
        return groups;
    },
    
    /**
     * Clear filter cache
     */
    clearCache() {
        this.filterOptionsCache = null;
    }
};

// Export for ES modules
if (typeof window !== 'undefined') {
    window.SkateFilters = SkateFilters;
}
