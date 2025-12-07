/**
 * Utils Module - Utility functions
 */

const SkateUtils = {
    /**
     * Debounce function to limit rapid calls
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },
    
    /**
     * Format date for display
     */
    formatDate(date, options = {}) {
        const defaultOptions = {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
        };
        return new Date(date).toLocaleDateString('en-CA', { ...defaultOptions, ...options });
    },
    
    /**
     * Format time for display (12-hour format)
     */
    formatTime(timeStr) {
        if (!timeStr) return '';
        
        const match = timeStr.match(/(\d{1,2}):(\d{2})/);
        if (!match) return timeStr;
        
        let hours = parseInt(match[1]);
        const mins = match[2];
        const period = hours >= 12 ? 'PM' : 'AM';
        
        hours = hours % 12 || 12;
        
        return `${hours}:${mins} ${period}`;
    },
    
    /**
     * Get relative time string (e.g., "in 2 hours", "tomorrow")
     */
    getRelativeTime(date) {
        const now = new Date();
        const target = new Date(date);
        const diffMs = target - now;
        const diffHours = diffMs / (1000 * 60 * 60);
        const diffDays = diffHours / 24;
        
        if (diffMs < 0) return 'Past';
        if (diffHours < 1) return 'Soon';
        if (diffHours < 24) return `In ${Math.round(diffHours)} hours`;
        if (diffDays < 2) return 'Tomorrow';
        if (diffDays < 7) return `In ${Math.round(diffDays)} days`;
        
        return target.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    },
    
    /**
     * Calculate distance between two coordinates (Haversine formula)
     */
    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth's radius in km
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        const a = 
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    },
    
    toRad(deg) {
        return deg * (Math.PI / 180);
    },
    
    /**
     * Get user's current location
     */
    getUserLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Geolocation not supported'));
                return;
            }
            
            navigator.geolocation.getCurrentPosition(
                position => resolve({
                    lat: position.coords.latitude,
                    lng: position.coords.longitude
                }),
                error => reject(error),
                { enableHighAccuracy: true, timeout: 10000 }
            );
        });
    },
    
    /**
     * Generate a unique ID
     */
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },
    
    /**
     * Truncate text with ellipsis
     */
    truncate(text, maxLength) {
        if (!text || text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
    },
    
    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
    
    /**
     * Deep clone an object
     */
    deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    },
    
    /**
     * Check if on mobile device
     */
    isMobile() {
        return window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    },
    
    /**
     * Get today's day name
     */
    getTodayName() {
        return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
    },
    
    /**
     * Share program (if Web Share API available)
     */
    async shareProgram(program) {
        const title = program.Activity || program['Activity Title'] || 'Skating Program';
        const location = program.LocationName || program['Location Name'] || '';
        const time = program['Start Time'] || '';
        const text = `${title} at ${location} - ${time}`;
        
        if (navigator.share) {
            try {
                await navigator.share({ title, text, url: window.location.href });
                return true;
            } catch (e) {
                console.log('Share cancelled');
            }
        }
        
        // Fallback: copy to clipboard
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            return false;
        }
    }
};

// Export for ES modules
if (typeof window !== 'undefined') {
    window.SkateUtils = SkateUtils;
}
