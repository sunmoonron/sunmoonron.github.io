// ============================================
        // NOSTR ORBIT — User Activity Timeline
        // ============================================
        // Visualize any Nostr user's 24h activity
        // See their posts & replies in a timeline
        // ============================================

        // State
        let users = [];
        let selectedUser = null;
        let userEvents = [];
        let viewMode = 'all'; // 'posts', 'replies', 'all'
        let selectedEvent = null;
        let timeRangeHours = 24;
        let seenEventIds = new Set(); // For deduplication
        
        // Thread visualization
        let showThreadLines = false;
        let eventPositions = new Map(); // eventId -> {x, y}
        let parentEvents = new Map(); // eventId -> parentEventId
        
        // Animation playback
        let isPlaying = false;
        let playbackIndex = 0;
        let playbackSpeed = 1; // 1x, 2x, 4x, 8x
        let playbackInterval = null;
        let sortedEventsForPlayback = [];
        
        // NIP-07 Identity
        let currentIdentity = null; // { pubkey, npub, name, picture }
        
        // Comparison mode
        let compareMode = false;
        let compareUser = null;
        let compareEvents = [];
        let compareCanvas = null;
        let compareCtx = null;
        let compareEventPositions = new Map();
        
        // Request tracking for cancellation
        let currentRequestId = 0;
        let isLoading = false;
        
        // Relay management
        const DEFAULT_RELAYS = [
            'wss://relay.damus.io',
            'wss://nos.lol',
            'wss://relay.snort.social',
            'wss://relay.primal.net',
            'wss://nostr.wine'
        ];
        
        let relays = []; // { url, enabled, status, socket }
        let activeConnections = new Map(); // url -> WebSocket
        
        // Default users to load (popular Nostr users)
        const DEFAULT_USERS = [
            'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m', // jack
            'npub1a2cww4kn9wqte4ry70vyfwqyqvpswksna27rtxd8vty6c74era8sdcw83a', // Lyn Alden  
            'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', // fiatjaf
            'npub1gcxzte5zlkncx26j68ez60fzkvtkm9e0vrwdcvsjakxf9mu9qewqlfnj5z', // odell
            'npub1qny3tkh0acurzla8x3zy4nhrjz5zd8l9sy9jys09umwng00manysew95gx', // calle
        ];

        // Initialize
        document.addEventListener('DOMContentLoaded', init);

        async function init() {
            setupCanvas();
            setupCompareCanvas();
            loadStoredRelays();
            renderRelayList();
            updateRelayCount();
            loadStoredUsers();
            if (users.length === 0) {
                loadDefaultUsers();
            }
            renderUserList();
            
            // Check for NIP-07 extension
            checkNip07Extension();
            
            // Try to restore previous session
            restoreIdentity();
        }
        
        function setupCompareCanvas() {
            compareCanvas = document.getElementById('compare-canvas');
            if (!compareCanvas) return;
            compareCtx = compareCanvas.getContext('2d');
            
            // Resize on window resize
            window.addEventListener('resize', () => {
                if (compareMode) {
                    resizeCompareCanvas();
                    if (compareUser) {
                        drawCompareBackground();
                        renderCompareTimeline();
                    }
                }
            });
        }
        
        function resizeCompareCanvas() {
            if (!compareCanvas) return;
            const container = document.getElementById('compare-container');
            compareCanvas.width = container.offsetWidth;
            compareCanvas.height = container.offsetHeight;
        }
        
        // ============================================
        // RELAY MANAGEMENT
        // ============================================
        
        function loadStoredRelays() {
            const stored = localStorage.getItem('nostr_orbit_relays');
            if (stored) {
                try {
                    relays = JSON.parse(stored);
                } catch (e) {
                    initDefaultRelays();
                }
            } else {
                initDefaultRelays();
            }
        }
        
        function initDefaultRelays() {
            relays = DEFAULT_RELAYS.map(url => ({
                url,
                enabled: true,
                status: 'closed' // 'connecting', 'connected', 'error', 'closed'
            }));
            saveRelays();
        }
        
        function saveRelays() {
            const toSave = relays.map(r => ({ url: r.url, enabled: r.enabled }));
            localStorage.setItem('nostr_orbit_relays', JSON.stringify(toSave));
        }
        
        function toggleRelayManager() {
            document.getElementById('relay-manager').classList.toggle('show');
        }
        
        function renderRelayList() {
            const container = document.getElementById('relay-list');
            container.innerHTML = relays.map((relay, i) => `
                <div class="relay-item">
                    <div class="relay-dot ${relay.status}"></div>
                    <span class="relay-url" title="${relay.url}">${relay.url.replace('wss://', '')}</span>
                    <button class="relay-toggle ${relay.enabled ? 'active' : ''}" 
                            onclick="toggleRelay(${i})">${relay.enabled ? 'ON' : 'OFF'}</button>
                </div>
            `).join('');
        }
        
        function renderRelayBar() {
            const container = document.getElementById('relay-bar');
            const enabledRelays = relays.filter(r => r.enabled);
            container.innerHTML = enabledRelays.map(relay => `
                <div class="relay-chip" title="${relay.url}">
                    <div class="relay-dot ${relay.status}"></div>
                    ${relay.url.replace('wss://', '').split('/')[0].slice(0, 15)}
                </div>
            `).join('');
        }
        
        function updateRelayCount() {
            const enabled = relays.filter(r => r.enabled).length;
            const connected = relays.filter(r => r.status === 'connected').length;
            document.getElementById('relay-count').textContent = `${connected}/${enabled}`;
        }
        
        function toggleRelay(index) {
            relays[index].enabled = !relays[index].enabled;
            if (!relays[index].enabled) {
                relays[index].status = 'closed';
                const socket = activeConnections.get(relays[index].url);
                if (socket) {
                    socket.close();
                    activeConnections.delete(relays[index].url);
                }
            }
            saveRelays();
            renderRelayList();
            renderRelayBar();
            updateRelayCount();
        }
        
        function addCustomRelay() {
            const input = document.getElementById('new-relay-input');
            let url = input.value.trim();
            if (!url) return;
            
            // Normalize URL
            if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
                url = 'wss://' + url;
            }
            
            if (relays.find(r => r.url === url)) {
                showToast('Relay already added');
                return;
            }
            
            relays.push({ url, enabled: true, status: 'closed' });
            saveRelays();
            renderRelayList();
            renderRelayBar();
            updateRelayCount();
            input.value = '';
            showToast('Relay added!');
        }
        
        function setTimeRange(hours) {
            // Cancel any pending requests
            currentRequestId++;
            closeAllConnections();
            
            timeRangeHours = hours;
            
            // Update button states
            document.querySelectorAll('.time-btn').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.hours) === hours);
            });
            
            // Clear custom input if preset button clicked
            document.getElementById('custom-time-input').value = '';
            
            if (selectedUser) {
                fetchUserEvents(selectedUser.pubkey);
            }
            
            // Also refresh compare user if in compare mode
            if (compareMode && compareUser) {
                fetchCompareUserEvents(compareUser.pubkey);
            }
        }
        
        function setCustomTimeRange(value) {
            const hours = parseInt(value);
            if (isNaN(hours) || hours < 1) {
                showToast('⚠️ Enter a valid number of hours');
                return;
            }
            if (hours > 720) {
                showToast('⚠️ Maximum 30 days (720 hours)');
                return;
            }
            
            // Cancel pending requests
            currentRequestId++;
            closeAllConnections();
            
            timeRangeHours = hours;
            
            // Deactivate preset buttons
            document.querySelectorAll('.time-btn').forEach(btn => {
                btn.classList.remove('active');
            });
            
            if (selectedUser) {
                fetchUserEvents(selectedUser.pubkey);
            }
            
            if (compareMode && compareUser) {
                fetchCompareUserEvents(compareUser.pubkey);
            }
            
            showToast(`⏱️ Showing last ${hours} hours`);
        }
        
        function closeAllConnections() {
            // Close all active WebSocket connections
            activeConnections.forEach((socket, url) => {
                if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
                    socket.close();
                }
            });
            activeConnections.clear();
            
            // Reset relay statuses
            relays.forEach(r => r.status = 'closed');
            renderRelayBar();
            updateRelayCount();
        }

        // ============================================
        // USER MANAGEMENT
        // ============================================

        function loadStoredUsers() {
            const stored = localStorage.getItem('nostr_orbit_users');
            if (stored) {
                try {
                    users = JSON.parse(stored);
                } catch (e) {
                    users = [];
                }
            }
        }

        function saveUsers() {
            localStorage.setItem('nostr_orbit_users', JSON.stringify(users));
        }

        function loadDefaultUsers() {
            DEFAULT_USERS.forEach(npub => {
                const pubkey = npubToHex(npub);
                if (pubkey) {
                    users.push({
                        pubkey,
                        npub,
                        name: null,
                        picture: null,
                        about: null,
                        lastActivity: null,
                        postCount: 0
                    });
                }
            });
            saveUsers();
            fetchAllUserProfiles();
        }

        function npubToHex(npub) {
            try {
                if (npub.startsWith('npub1')) {
                    const decoded = NostrTools.nip19.decode(npub);
                    return decoded.data;
                }
                // Assume it's already hex
                if (/^[0-9a-fA-F]{64}$/.test(npub)) {
                    return npub.toLowerCase();
                }
            } catch (e) {
                console.error('Invalid npub:', e);
            }
            return null;
        }

        function hexToNpub(hex) {
            try {
                return NostrTools.nip19.npubEncode(hex);
            } catch (e) {
                return hex.slice(0, 8) + '...' + hex.slice(-4);
            }
        }

        function addUserFromInput() {
            const input = document.getElementById('npub-input');
            const value = input.value.trim();
            if (!value) return;
            
            const pubkey = npubToHex(value);
            if (!pubkey) {
                showToast('Invalid npub or pubkey');
                return;
            }
            
            if (users.find(u => u.pubkey === pubkey)) {
                showToast('User already added');
                return;
            }
            
            users.push({
                pubkey,
                npub: hexToNpub(pubkey),
                name: null,
                picture: null,
                about: null,
                lastActivity: null,
                postCount: 0
            });
            
            saveUsers();
            renderUserList();
            fetchUserProfile(pubkey);
            input.value = '';
            showToast('User added!');
        }

        function removeUser(pubkey, e) {
            e.stopPropagation();
            users = users.filter(u => u.pubkey !== pubkey);
            saveUsers();
            if (selectedUser?.pubkey === pubkey) {
                selectedUser = null;
                clearTimeline();
            }
            renderUserList();
        }

        function sortUsers(sortType) {
            document.querySelectorAll('.sort-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.sort === sortType);
            });
            
            switch (sortType) {
                case 'recent':
                    users.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
                    break;
                case 'posts':
                    users.sort((a, b) => (b.postCount || 0) - (a.postCount || 0));
                    break;
                case 'name':
                    users.sort((a, b) => (a.name || a.npub).localeCompare(b.name || b.npub));
                    break;
            }
            
            renderUserList();
        }

        function renderUserList() {
            const container = document.getElementById('user-list');
            
            if (users.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="icon">👥</div>
                        <p>Add Nostr users to track their activity</p>
                    </div>
                `;
                return;
            }
            
            container.innerHTML = users.map(user => `
                <div class="user-card ${selectedUser?.pubkey === user.pubkey ? 'selected' : ''}" 
                     onclick="selectUser('${user.pubkey}')">
                    <div class="user-avatar">
                        ${user.picture 
                            ? `<img src="${user.picture}" onerror="this.parentElement.innerHTML='👤'">`
                            : '👤'}
                    </div>
                    <div class="user-info">
                        <div class="user-name">${user.name || 'Loading...'}</div>
                        <div class="user-npub">${user.npub.slice(0, 12)}...${user.npub.slice(-4)}</div>
                        <div class="user-stats">${user.postCount || 0} posts in 24h</div>
                    </div>
                    ${compareMode ? `
                        <button class="user-compare-btn ${compareUser?.pubkey === user.pubkey ? 'active' : ''}" 
                                onclick="selectCompareUser('${user.pubkey}', event)" 
                                title="Compare with this user">
                            ${compareUser?.pubkey === user.pubkey ? '📊' : '⚖️'}
                        </button>
                    ` : ''}
                    <button class="user-remove" onclick="removeUser('${user.pubkey}', event)">×</button>
                </div>
            `).join('');
        }

        // ============================================
        // PROFILE FETCHING
        // ============================================

        async function fetchAllUserProfiles() {
            const pubkeys = users.map(u => u.pubkey);
            const filter = {
                kinds: [0],
                authors: pubkeys
            };
            connectToMultipleRelays('profiles', filter, handleProfileEvent);
        }

        async function fetchUserProfile(pubkey) {
            const filter = {
                kinds: [0],
                authors: [pubkey]
            };
            connectToMultipleRelays('profile-' + pubkey.slice(0, 8), filter, handleProfileEvent);
        }

        function handleProfileEvent(event) {
            if (event.kind !== 0) return;
            
            try {
                const profile = JSON.parse(event.content);
                const user = users.find(u => u.pubkey === event.pubkey);
                if (user) {
                    user.name = profile.name || profile.display_name || profile.displayName;
                    user.picture = profile.picture;
                    user.about = profile.about;
                    saveUsers();
                    renderUserList();
                }
            } catch (e) {
                console.error('Failed to parse profile:', e);
            }
        }

        // ============================================
        // USER SELECTION & EVENT FETCHING
        // ============================================

        function selectUser(pubkey) {
            const user = users.find(u => u.pubkey === pubkey);
            if (!user) return;
            
            selectedUser = user;
            renderUserList();
            
            document.getElementById('selected-user-info').textContent = 
                `Loading ${user.name || 'user'}'s 24h activity...`;
            
            fetchUserEvents(pubkey);
        }

        function fetchUserEvents(pubkey) {
            // Increment request ID to invalidate previous requests
            const thisRequestId = ++currentRequestId;
            isLoading = true;
            
            userEvents = [];
            seenEventIds.clear();
            parentEvents.clear();
            clearTimeline();
            
            const now = Math.floor(Date.now() / 1000);
            const rangeStart = now - (timeRangeHours * 60 * 60);
            
            // Show loading state
            document.getElementById('selected-user-info').innerHTML = 
                `<span class="spinner" style="display:inline-block;width:12px;height:12px;border-width:2px;margin-right:8px;"></span>Loading...`;
            
            const filter = {
                kinds: [1], // Text notes only
                authors: [pubkey],
                since: rangeStart,
                until: now,
                limit: 500 // Limit to prevent overload
            };
            
            const handleEvent = (event) => {
                // Check if this request is still valid
                if (thisRequestId !== currentRequestId) return;
                
                if (event.pubkey !== pubkey) return;
                
                // Deduplicate events
                if (seenEventIds.has(event.id)) return;
                seenEventIds.add(event.id);
                
                // Determine if post or reply and extract parent event ID
                const eTags = event.tags.filter(t => t[0] === 'e');
                const isReply = eTags.length > 0;
                
                // Get the parent event ID (last 'e' tag with 'reply' marker, or just the last 'e' tag)
                let parentEventId = null;
                if (isReply) {
                    const replyTag = eTags.find(t => t[3] === 'reply');
                    const rootTag = eTags.find(t => t[3] === 'root');
                    parentEventId = replyTag?.[1] || eTags[eTags.length - 1]?.[1];
                    
                    // Store parent relationship
                    if (parentEventId) {
                        parentEvents.set(event.id, parentEventId);
                    }
                }
                
                userEvents.push({
                    id: event.id,
                    content: event.content,
                    created_at: event.created_at,
                    isReply,
                    parentEventId,
                    tags: event.tags
                });
                
                // Update user stats
                const user = users.find(u => u.pubkey === pubkey);
                if (user) {
                    user.postCount = userEvents.length;
                    user.lastActivity = Math.max(user.lastActivity || 0, event.created_at);
                }
                
                // Debounce render with request ID check
                clearTimeout(window.renderTimeout);
                window.renderTimeout = setTimeout(() => {
                    if (thisRequestId !== currentRequestId) return;
                    saveUsers();
                    renderTimeline();
                    updateStats();
                    renderEventFeed();
                    renderUserList();
                }, 150);
            };
            
            const handleEose = () => {
                if (thisRequestId !== currentRequestId) return;
                isLoading = false;
                
                if (userEvents.length === 0) {
                    document.getElementById('selected-user-info').textContent = 
                        `${selectedUser?.name || 'User'} has no events in the last ${timeRangeHours}h`;
                } else {
                    document.getElementById('selected-user-info').textContent = 
                        `${selectedUser?.name || 'User'} — ${userEvents.length} events in ${timeRangeHours}h`;
                }
                
                // Update compare stats if in compare mode
                if (compareMode && compareUser) {
                    updateCompareStats();
                }
            };
            
            connectToMultipleRelays('user-events-' + thisRequestId, filter, handleEvent, handleEose);
        }

        // ============================================
        // TIMELINE VISUALIZATION
        // ============================================

        function setupCanvas() {
            const canvas = document.getElementById('timeline-canvas');
            const ctx = canvas.getContext('2d');
            
            function resize() {
                const container = document.getElementById('canvas-container');
                canvas.width = container.clientWidth;
                canvas.height = container.clientHeight;
                drawTimelineBackground(ctx, canvas.width, canvas.height);
            }
            
            resize();
            window.addEventListener('resize', resize);
        }

        function drawTimelineBackground(ctx, width, height) {
            ctx.clearRect(0, 0, width, height);
            
            // Draw circular timeline
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.min(width, height) * 0.35;
            
            // Outer glow
            const gradient = ctx.createRadialGradient(centerX, centerY, radius * 0.8, centerX, centerY, radius * 1.2);
            gradient.addColorStop(0, 'rgba(99, 102, 241, 0.1)');
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius * 1.2, 0, Math.PI * 2);
            ctx.fill();
            
            // Main circle
            ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            ctx.stroke();
            
            // Hour markers
            ctx.fillStyle = '#444';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            for (let i = 0; i < 24; i++) {
                const angle = (i / 24) * Math.PI * 2 - Math.PI / 2; // Start at top
                const markerRadius = radius + 25;
                const x = centerX + Math.cos(angle) * markerRadius;
                const y = centerY + Math.sin(angle) * markerRadius;
                
                // Tick mark
                const tickStart = radius - 5;
                const tickEnd = radius + 5;
                ctx.strokeStyle = i % 6 === 0 ? 'rgba(99, 102, 241, 0.5)' : 'rgba(99, 102, 241, 0.2)';
                ctx.lineWidth = i % 6 === 0 ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(centerX + Math.cos(angle) * tickStart, centerY + Math.sin(angle) * tickStart);
                ctx.lineTo(centerX + Math.cos(angle) * tickEnd, centerY + Math.sin(angle) * tickEnd);
                ctx.stroke();
                
                // Hour label (every 6 hours)
                if (i % 6 === 0) {
                    ctx.fillText(`${i}:00`, x, y);
                }
            }
            
            // Center label
            ctx.fillStyle = '#666';
            ctx.font = '11px monospace';
            const timeLabel = timeRangeHours >= 24 ? `${timeRangeHours/24}D` : `${timeRangeHours}H`;
            ctx.fillText(timeLabel, centerX, centerY - 10);
            ctx.fillText('TIMELINE', centerX, centerY + 10);
        }

        function renderTimeline() {
            const container = document.getElementById('canvas-container');
            const nodesContainer = document.getElementById('event-nodes');
            nodesContainer.innerHTML = '';
            
            // Clear previous positions
            eventPositions.clear();
            
            // Clear SVG lines
            clearSvgLines();
            
            const width = container.clientWidth;
            const height = container.clientHeight;
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.min(width, height) * 0.35;
            
            // Filter events based on view mode
            const filteredEvents = userEvents.filter(e => {
                if (viewMode === 'posts') return !e.isReply;
                if (viewMode === 'replies') return e.isReply;
                return true;
            });
            
            // Sort by time
            filteredEvents.sort((a, b) => a.created_at - b.created_at);
            
            // Get time range
            const now = Math.floor(Date.now() / 1000);
            const rangeStart = now - (timeRangeHours * 60 * 60);
            
            filteredEvents.forEach((event, index) => {
                // Calculate position on circle
                const timeSinceStart = event.created_at - rangeStart;
                const progress = timeSinceStart / (timeRangeHours * 60 * 60);
                const angle = progress * Math.PI * 2 - Math.PI / 2; // Start at top
                
                // Slight radius variation for visual interest (deterministic based on event id)
                const hash = event.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                const eventRadius = radius + ((hash % 20) - 10);
                const x = centerX + Math.cos(angle) * eventRadius;
                const y = centerY + Math.sin(angle) * eventRadius;
                
                // Store position for connection drawing
                eventPositions.set(event.id, { x, y });
                
                // Check if this event has a thread connection within our visible events
                const hasVisibleThread = event.parentEventId && 
                    filteredEvents.some(e => e.id === event.parentEventId);
                
                const node = document.createElement('div');
                node.className = `event-node ${event.isReply ? 'reply' : 'post'}${hasVisibleThread ? ' has-thread' : ''}`;
                node.style.left = x + 'px';
                node.style.top = y + 'px';
                node.dataset.eventId = event.id;
                node.title = formatTime(event.created_at) + '\n' + event.content.slice(0, 100);
                
                node.addEventListener('click', () => selectEvent(event, false));
                node.addEventListener('mouseenter', () => highlightThread(event));
                node.addEventListener('mouseleave', () => clearThreadHighlight());
                
                nodesContainer.appendChild(node);
            });
            
            // Draw thread connection lines
            if (showThreadLines) {
                renderThreadLines(filteredEvents);
            }
            
            const rangeLabel = timeRangeHours >= 24 ? `${timeRangeHours/24} day${timeRangeHours > 24 ? 's' : ''}` : `${timeRangeHours}h`;
            document.getElementById('selected-user-info').textContent = 
                `${selectedUser?.name || 'User'} — ${filteredEvents.length} events in ${rangeLabel}`;
            
            // Initialize playback
            initPlayback();
        }

        function toggleThreadLines() {
            showThreadLines = !showThreadLines;
            const btn = document.getElementById('thread-toggle');
            btn.classList.toggle('active', showThreadLines);
            
            // Count threads for both main and compare views
            const mainThreads = userEvents.filter(e => 
                e.parentEventId && userEvents.some(p => p.id === e.parentEventId)
            ).length;
            
            const compareThreads = compareMode ? compareEvents.filter(e => 
                e.parentEventId && compareEvents.some(p => p.id === e.parentEventId)
            ).length : 0;
            
            const totalThreads = mainThreads + compareThreads;
            
            btn.innerHTML = showThreadLines 
                ? `🔗 Hide (${totalThreads})` 
                : `🔗 Threads`;
            
            if (showThreadLines && userEvents.length > 0) {
                // Re-render to draw lines
                renderTimeline();
                
                // Also render compare threads if in compare mode
                if (compareMode && compareEvents.length > 0) {
                    renderCompareThreadLines();
                }
            } else {
                // Clear the lines
                clearSvgLines();
                clearCompareSvgLines();
            }
        }
        
        function clearSvgLines() {
            const svg = document.getElementById('connections-svg');
            if (!svg) return;
            
            // Remove all path elements but keep defs
            const paths = svg.querySelectorAll('path');
            paths.forEach(p => p.remove());
        }
        
        function clearCompareSvgLines() {
            const svg = document.getElementById('compare-connections-svg');
            if (!svg) return;
            
            const paths = svg.querySelectorAll('path');
            paths.forEach(p => p.remove());
        }
        
        function renderCompareThreadLines() {
            const svg = document.getElementById('compare-connections-svg');
            if (!svg) return;
            
            // Clear existing lines
            clearCompareSvgLines();
            
            const filteredEvents = compareEvents.filter(e => {
                if (viewMode === 'posts') return !e.isReply;
                if (viewMode === 'replies') return e.isReply;
                return true;
            });
            
            filteredEvents.forEach(event => {
                if (!event.parentEventId) return;
                
                const parentPos = compareEventPositions.get(event.parentEventId);
                const childPos = compareEventPositions.get(event.id);
                
                if (!parentPos || !childPos) return;
                
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                
                const dx = childPos.x - parentPos.x;
                const dy = childPos.y - parentPos.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                const container = document.getElementById('compare-container');
                const centerX = container.clientWidth / 2;
                const centerY = container.clientHeight / 2;
                
                const midX = (parentPos.x + childPos.x) / 2;
                const midY = (parentPos.y + childPos.y) / 2;
                
                const ctrlX = midX + (centerX - midX) * 0.2;
                const ctrlY = midY + (centerY - midY) * 0.2;
                
                const d = `M ${parentPos.x} ${parentPos.y} Q ${ctrlX} ${ctrlY} ${childPos.x} ${childPos.y}`;
                
                path.setAttribute('d', d);
                path.setAttribute('class', 'connection-line compare-thread');
                path.dataset.parentId = event.parentEventId;
                path.dataset.childId = event.id;
                
                svg.appendChild(path);
            });
        }
        
        function updateThreadButtonCount() {
            const visibleThreads = userEvents.filter(e => 
                e.parentEventId && userEvents.some(p => p.id === e.parentEventId)
            ).length;
            
            const btn = document.getElementById('thread-toggle');
            if (visibleThreads > 0 && showThreadLines) {
                btn.innerHTML = `🔗 Threads (${visibleThreads})`;
            } else if (visibleThreads > 0) {
                btn.innerHTML = `🔗 Show Threads (${visibleThreads})`;
            } else {
                btn.innerHTML = '🔗 Show Threads';
            }
        }
        
        function renderThreadLines(events) {
            const svg = document.getElementById('connections-svg');
            if (!svg) return;
            
            // Clear existing lines
            clearSvgLines();
            
            let threadCount = 0;
            
            events.forEach(event => {
                if (!event.parentEventId) return;
                
                const parentPos = eventPositions.get(event.parentEventId);
                const childPos = eventPositions.get(event.id);
                
                if (!parentPos || !childPos) return;
                
                threadCount++;
                
                // Create curved path between parent and child
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                
                // Calculate control points for a nice curve
                const dx = childPos.x - parentPos.x;
                const dy = childPos.y - parentPos.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                // Curve towards center for better visibility
                const container = document.getElementById('canvas-container');
                const centerX = container.clientWidth / 2;
                const centerY = container.clientHeight / 2;
                
                const midX = (parentPos.x + childPos.x) / 2;
                const midY = (parentPos.y + childPos.y) / 2;
                
                // Pull control point towards center
                const pullFactor = Math.min(distance * 0.3, 50);
                const ctrlX = midX + (centerX - midX) * 0.2;
                const ctrlY = midY + (centerY - midY) * 0.2;
                
                const d = `M ${parentPos.x} ${parentPos.y} Q ${ctrlX} ${ctrlY} ${childPos.x} ${childPos.y}`;
                
                path.setAttribute('d', d);
                path.setAttribute('class', 'connection-line thread');
                path.dataset.parentId = event.parentEventId;
                path.dataset.childId = event.id;
                
                svg.appendChild(path);
            });
            
            // Update button with thread count
            updateThreadButtonCount();
        }
        
        function highlightThread(event) {
            if (!showThreadLines) return;
            
            // Find all events in this thread chain
            const threadEventIds = new Set();
            
            // Walk up the chain
            let currentId = event.id;
            while (currentId) {
                threadEventIds.add(currentId);
                currentId = parentEvents.get(currentId);
            }
            
            // Walk down the chain (find children)
            const findChildren = (parentId) => {
                userEvents.forEach(e => {
                    if (e.parentEventId === parentId && !threadEventIds.has(e.id)) {
                        threadEventIds.add(e.id);
                        findChildren(e.id);
                    }
                });
            };
            findChildren(event.id);
            
            // Highlight relevant lines
            document.querySelectorAll('.connection-line').forEach(line => {
                const parentId = line.dataset.parentId;
                const childId = line.dataset.childId;
                
                if (threadEventIds.has(parentId) || threadEventIds.has(childId)) {
                    line.classList.add('highlighted');
                    line.classList.remove('dimmed');
                } else {
                    line.classList.add('dimmed');
                    line.classList.remove('highlighted');
                }
            });
            
            // Highlight nodes
            document.querySelectorAll('.event-node').forEach(node => {
                if (threadEventIds.has(node.dataset.eventId)) {
                    node.style.transform = 'translate(-50%, -50%) scale(1.3)';
                    node.style.zIndex = '50';
                } else {
                    node.style.opacity = '0.4';
                }
            });
        }
        
        function clearThreadHighlight() {
            document.querySelectorAll('.connection-line').forEach(line => {
                line.classList.remove('highlighted', 'dimmed');
            });
            
            document.querySelectorAll('.event-node').forEach(node => {
                node.style.transform = '';
                node.style.zIndex = '';
                node.style.opacity = '';
            });
        }
        
        function clearTimeline() {
            const canvas = document.getElementById('timeline-canvas');
            const ctx = canvas.getContext('2d');
            drawTimelineBackground(ctx, canvas.width, canvas.height);
            document.getElementById('event-nodes').innerHTML = '';
            
            // Clear SVG lines
            clearSvgLines();
            
            // Clear position maps
            eventPositions.clear();
            parentEvents.clear();
            
            // Reset thread button
            const btn = document.getElementById('thread-toggle');
            if (btn) btn.innerHTML = '🔗 Show Threads';
            
            // Stop any playback
            stopPlayback();
            resetPlaybackUI();
            
            document.getElementById('event-detail').innerHTML = `
                <h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:12px;">📝 Event Feed</h3>
                <div class="empty-state">
                    <div class="icon">🔭</div>
                    <p>Select a user to view their events</p>
                </div>
            `;
        }

        // ============================================
        // ANIMATION PLAYBACK
        // ============================================
        
        function initPlayback() {
            // Get filtered and sorted events from main timeline
            let mainEvents = userEvents.filter(e => {
                if (viewMode === 'posts') return !e.isReply;
                if (viewMode === 'replies') return e.isReply;
                return true;
            }).map(e => ({ ...e, isCompareEvent: false }));
            
            // Include compare events if in compare mode
            let allEvents = mainEvents;
            if (compareMode && compareEvents.length > 0) {
                const filteredCompareEvents = compareEvents.filter(e => {
                    if (viewMode === 'posts') return !e.isReply;
                    if (viewMode === 'replies') return e.isReply;
                    return true;
                }).map(e => ({ ...e, isCompareEvent: true }));
                
                allEvents = [...mainEvents, ...filteredCompareEvents];
            }
            
            // Sort all events by time
            sortedEventsForPlayback = allEvents.sort((a, b) => a.created_at - b.created_at);
            
            playbackIndex = 0;
            updatePlaybackUI();
        }
        
        function togglePlayback() {
            if (isPlaying) {
                stopPlayback();
            } else {
                startPlayback();
            }
        }
        
        function startPlayback() {
            if (sortedEventsForPlayback.length === 0) {
                initPlayback();
            }
            
            if (sortedEventsForPlayback.length === 0) return;
            
            // If at the end, restart
            if (playbackIndex >= sortedEventsForPlayback.length) {
                resetPlayback();
            }
            
            // Hide all nodes initially if starting from beginning
            if (playbackIndex === 0) {
                document.querySelectorAll('.event-node').forEach(node => {
                    node.classList.add('hidden');
                    node.classList.remove('animated-in');
                });
            }
            
            isPlaying = true;
            document.getElementById('play-btn').textContent = '⏸️';
            document.getElementById('play-btn').classList.add('active');
            
            // Calculate interval based on speed
            const baseInterval = 300; // ms per event at 1x
            const interval = baseInterval / playbackSpeed;
            
            playbackInterval = setInterval(() => {
                if (playbackIndex < sortedEventsForPlayback.length) {
                    showEventAtIndex(playbackIndex);
                    playbackIndex++;
                    updatePlaybackUI();
                } else {
                    stopPlayback();
                }
            }, interval);
        }
        
        function stopPlayback() {
            isPlaying = false;
            if (playbackInterval) {
                clearInterval(playbackInterval);
                playbackInterval = null;
            }
            document.getElementById('play-btn').textContent = '▶️';
            document.getElementById('play-btn').classList.remove('active');
        }
        
        function resetPlayback() {
            stopPlayback();
            playbackIndex = 0;
            
            // Show all nodes
            document.querySelectorAll('.event-node').forEach(node => {
                node.classList.remove('hidden', 'animated-in');
            });
            
            updatePlaybackUI();
        }
        
        function showEventAtIndex(index) {
            const event = sortedEventsForPlayback[index];
            if (!event) return;
            
            // Find node in correct container based on whether it's a compare event
            const containerId = event.isCompareEvent ? 'compare-nodes' : 'event-nodes';
            const node = document.querySelector(`#${containerId} .event-node[data-event-id="${event.id}"]`);
            if (node) {
                node.classList.remove('hidden');
                node.classList.add('animated-in');
                
                // Draw thread line if applicable and threads are enabled
                if (showThreadLines && event.parentEventId) {
                    const positions = event.isCompareEvent ? compareEventPositions : eventPositions;
                    const parentPos = positions.get(event.parentEventId);
                    const childPos = positions.get(event.id);
                    
                    if (parentPos && childPos) {
                        drawSingleThreadLine(event, parentPos, childPos, event.isCompareEvent);
                    }
                }
            }
        }
        
        function drawSingleThreadLine(event, parentPos, childPos, isCompare = false) {
            const svgId = isCompare ? 'compare-connections-svg' : 'connections-svg';
            const containerId = isCompare ? 'compare-container' : 'canvas-container';
            const svg = document.getElementById(svgId);
            if (!svg) return;
            
            const container = document.getElementById(containerId);
            const centerX = container.clientWidth / 2;
            const centerY = container.clientHeight / 2;
            
            const midX = (parentPos.x + childPos.x) / 2;
            const midY = (parentPos.y + childPos.y) / 2;
            
            const ctrlX = midX + (centerX - midX) * 0.2;
            const ctrlY = midY + (centerY - midY) * 0.2;
            
            const d = `M ${parentPos.x} ${parentPos.y} Q ${ctrlX} ${ctrlY} ${childPos.x} ${childPos.y}`;
            
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('class', 'connection-line thread');
            path.style.opacity = '0';
            path.style.transition = 'opacity 0.3s';
            path.dataset.parentId = event.parentEventId;
            path.dataset.childId = event.id;
            
            svg.appendChild(path);
            
            // Animate in
            requestAnimationFrame(() => {
                path.style.opacity = '0.6';
            });
        }
        
        function seekPlayback(e) {
            const progressBar = document.getElementById('playback-progress');
            const rect = progressBar.getBoundingClientRect();
            const percent = (e.clientX - rect.left) / rect.width;
            
            const wasPlaying = isPlaying;
            stopPlayback();
            
            playbackIndex = Math.floor(percent * sortedEventsForPlayback.length);
            playbackIndex = Math.max(0, Math.min(playbackIndex, sortedEventsForPlayback.length));
            
            // Show all events up to this point
            document.querySelectorAll('.event-node').forEach(node => {
                const eventId = node.dataset.eventId;
                const eventIndex = sortedEventsForPlayback.findIndex(e => e.id === eventId);
                
                if (eventIndex >= 0 && eventIndex < playbackIndex) {
                    node.classList.remove('hidden', 'animated-in');
                } else if (eventIndex >= playbackIndex) {
                    node.classList.add('hidden');
                    node.classList.remove('animated-in');
                }
            });
            
            // Redraw thread lines for visible events if enabled
            if (showThreadLines) {
                clearSvgLines();
                const visibleEvents = sortedEventsForPlayback.slice(0, playbackIndex);
                renderThreadLines(visibleEvents);
            }
            
            updatePlaybackUI();
            
            if (wasPlaying) {
                startPlayback();
            }
        }
        
        function cycleSpeed() {
            const speeds = [1, 2, 4, 8];
            const currentIndex = speeds.indexOf(playbackSpeed);
            playbackSpeed = speeds[(currentIndex + 1) % speeds.length];
            
            document.getElementById('playback-speed').textContent = `${playbackSpeed}x`;
            
            // Restart with new speed if playing
            if (isPlaying) {
                stopPlayback();
                startPlayback();
            }
        }
        
        function updatePlaybackUI() {
            const total = sortedEventsForPlayback.length;
            const current = playbackIndex;
            
            document.getElementById('playback-time').textContent = `${current} / ${total}`;
            
            const percent = total > 0 ? (current / total) * 100 : 0;
            document.getElementById('playback-progress-bar').style.width = `${percent}%`;
        }
        
        function resetPlaybackUI() {
            playbackIndex = 0;
            sortedEventsForPlayback = [];
            document.getElementById('playback-time').textContent = '0 / 0';
            document.getElementById('playback-progress-bar').style.width = '0%';
            document.getElementById('play-btn').textContent = '▶️';
            document.getElementById('play-btn').classList.remove('active');
        }

        // ============================================
        // VIEW MODE & EVENT DETAILS
        // ============================================

        function setViewMode(mode) {
            viewMode = mode;
            document.querySelectorAll('.toggle-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.view === mode);
            });
            if (selectedUser) {
                renderTimeline();
                updateStats();
                renderEventFeed();
            }
            // Also update compare timeline if in compare mode
            if (compareMode && compareUser) {
                renderCompareTimeline();
            }
        }

        function selectEvent(event, isCompareEvent = false) {
            selectedEvent = event;
            
            // Highlight node in appropriate container
            const container = isCompareEvent ? '#compare-nodes' : '#event-nodes';
            document.querySelectorAll(`${container} .event-node`).forEach(node => {
                node.classList.toggle('selected', node.dataset.eventId === event.id);
            });
            
            // Show event detail
            const userName = isCompareEvent ? (compareUser?.name || 'Compare User') : (selectedUser?.name || 'User');
            const accentColor = isCompareEvent ? 'var(--accent2)' : 'var(--accent)';
            
            const detailContainer = document.getElementById('event-detail');
            detailContainer.innerHTML = `
                <h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:${accentColor};margin-bottom:12px;">
                    ${isCompareEvent ? '📊' : '📝'} ${userName}'s Event
                </h3>
                <div class="event-card ${event.isReply ? 'reply' : 'post'}" style="border-left-color:${accentColor}">
                    <div class="event-time" style="color:${accentColor}">
                        ${event.isReply ? '↩️ Reply' : '📝 Post'} • ${formatTime(event.created_at)}
                    </div>
                    <div class="event-content">${escapeHtml(event.content)}</div>
                    <div class="event-meta">
                        <span>ID: ${event.id.slice(0, 8)}...</span>
                        ${event.tags?.filter(t => t[0] === 'p').length > 0 ? `<span>👥 ${event.tags.filter(t => t[0] === 'p').length} mentions</span>` : ''}
                    </div>
                    ${event.parentEventId ? `
                        <div class="thread-info">
                            <span class="thread-icon">↩️</span>
                            <span>Reply to ${event.parentEventId.slice(0, 8)}...</span>
                        </div>
                    ` : ''}
                </div>
                <button class="secondary" style="margin-top:10px;" onclick="renderEventFeed()">
                    ← Back to Feed
                </button>
            `;
        }

        function updateStats() {
            const posts = userEvents.filter(e => !e.isReply);
            const replies = userEvents.filter(e => e.isReply);
            
            document.getElementById('stat-total').textContent = userEvents.length;
            document.getElementById('stat-posts').textContent = posts.length;
            document.getElementById('stat-replies').textContent = replies.length;
            
            // Calculate peak hour
            if (userEvents.length > 0) {
                const hourCounts = {};
                userEvents.forEach(e => {
                    const hour = new Date(e.created_at * 1000).getHours();
                    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
                });
                const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
                document.getElementById('stat-peak').textContent = `${peakHour[0]}:00 (${peakHour[1]} events)`;
            } else {
                document.getElementById('stat-peak').textContent = '—';
            }
            
            // Count visible thread connections
            const visibleThreads = userEvents.filter(e => 
                e.parentEventId && userEvents.some(p => p.id === e.parentEventId)
            ).length;
            document.getElementById('stat-threads').textContent = 
                visibleThreads > 0 ? `${visibleThreads} visible` : '—';
        }

        function renderEventFeed(highlightEvent = null) {
            const container = document.getElementById('event-detail');
            
            const filteredEvents = userEvents.filter(e => {
                if (viewMode === 'posts') return !e.isReply;
                if (viewMode === 'replies') return e.isReply;
                return true;
            }).sort((a, b) => b.created_at - a.created_at);
            
            if (filteredEvents.length === 0) {
                container.innerHTML = `
                    <h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:12px;">📝 Event Feed</h3>
                    <div class="empty-state">
                        <div class="icon">📭</div>
                        <p>No ${viewMode === 'all' ? 'events' : viewMode} in the last 24h</p>
                    </div>
                `;
                return;
            }
            
            container.innerHTML = `
                <h3 style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666;margin-bottom:12px;">📝 Event Feed (${filteredEvents.length})</h3>
                ${filteredEvents.map(event => `
                    <div class="event-card ${event.isReply ? 'reply' : 'post'} ${highlightEvent?.id === event.id ? 'selected' : ''}"
                         onclick="selectEvent(userEvents.find(e => e.id === '${event.id}'))">
                        <div class="event-time">
                            ${event.isReply ? '↩️ Reply' : '📝 Post'} • ${formatTime(event.created_at)}
                        </div>
                        <div class="event-content">${escapeHtml(event.content.slice(0, 300))}${event.content.length > 300 ? '...' : ''}</div>
                        <div class="event-meta">
                            <span>ID: ${event.id.slice(0, 8)}...</span>
                            ${event.tags.filter(t => t[0] === 'p').length > 0 ? `<span>👥 ${event.tags.filter(t => t[0] === 'p').length} mentions</span>` : ''}
                        </div>
                        ${event.parentEventId ? `
                            <div class="thread-info">
                                <span class="thread-icon">↩️</span>
                                <span>Reply to ${event.parentEventId.slice(0, 8)}...</span>
                                ${userEvents.find(e => e.id === event.parentEventId) ? '<span style="color:#22c55e">• In view</span>' : ''}
                            </div>
                        ` : ''}
                    </div>
                `).join('')}
            `;
        }

        // ============================================
        // RELAY CONNECTION (MULTI-RELAY)
        // ============================================
        
        function connectToMultipleRelays(subId, filter, onEvent, onEose = null) {
            const enabledRelays = relays.filter(r => r.enabled);
            let eoseCount = 0;
            const totalRelays = enabledRelays.length;
            
            enabledRelays.forEach(relay => {
                connectToRelay(relay.url, subId, filter, onEvent, () => {
                    eoseCount++;
                    // Call onEose when all relays have responded
                    if (eoseCount >= totalRelays && onEose) {
                        onEose();
                    }
                });
            });
        }

        function connectToRelay(url, subId, filter, onEvent, onEose = null) {
            const relay = relays.find(r => r.url === url);
            if (relay) {
                relay.status = 'connecting';
                renderRelayBar();
                renderRelayList();
                updateRelayCount();
            }
            
            try {
                const socket = new WebSocket(url);
                activeConnections.set(url, socket);
                
                socket.onopen = () => {
                    if (relay) {
                        relay.status = 'connected';
                        renderRelayBar();
                        renderRelayList();
                        updateRelayCount();
                    }
                    socket.send(JSON.stringify(['REQ', subId, filter]));
                };
                
                socket.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            onEvent(data[2]);
                        } else if (data[0] === 'EOSE' && onEose) {
                            onEose();
                        }
                    } catch (e) {
                        console.error('Parse error:', e);
                    }
                };
                
                socket.onerror = (e) => {
                    console.error('WebSocket error:', e);
                    if (relay) {
                        relay.status = 'error';
                        renderRelayBar();
                        renderRelayList();
                        updateRelayCount();
                    }
                };
                
                socket.onclose = () => {
                    if (relay && relay.status !== 'error') {
                        relay.status = 'closed';
                        renderRelayBar();
                        renderRelayList();
                        updateRelayCount();
                    }
                    activeConnections.delete(url);
                };
                
                // Auto-close after 30 seconds
                setTimeout(() => {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.close();
                    }
                }, 30000);
                
                return socket;
            } catch (e) {
                console.error('Connection error:', e);
                if (relay) {
                    relay.status = 'error';
                    renderRelayBar();
                    renderRelayList();
                    updateRelayCount();
                }
                return null;
            }
        }

        // ============================================
        // UTILITIES
        // ============================================

        function formatTime(timestamp) {
            const date = new Date(timestamp * 1000);
            const now = new Date();
            const diff = now - date;
            
            if (diff < 60000) return 'Just now';
            if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
            
            // For events older than 24h, show day and time
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const dayName = days[date.getDay()];
            const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `${dayName} ${time}`;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function showToast(message) {
            const toast = document.getElementById('toast');
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }

        // ============================================
        // COMPARISON MODE
        // ============================================
        
        function toggleCompareMode() {
            compareMode = !compareMode;
            const app = document.getElementById('app');
            const btn = document.getElementById('compare-toggle');
            const statsPanel = document.getElementById('compare-stats');
            
            if (compareMode) {
                app.classList.add('compare-mode');
                btn.classList.add('active');
                btn.innerHTML = '📊 Exit';
                statsPanel.style.display = 'block';
                
                // Setup compare canvas after layout settles
                setTimeout(() => {
                    resizeCompareCanvas();
                    drawCompareBackground();
                    
                    // Also resize main canvas since grid changed
                    const canvas = document.getElementById('timeline-canvas');
                    const ctx = canvas.getContext('2d');
                    const container = document.getElementById('canvas-container');
                    canvas.width = container.clientWidth;
                    canvas.height = container.clientHeight;
                    
                    // Redraw the background circle
                    drawTimelineBackground(ctx, canvas.width, canvas.height);
                    
                    if (selectedUser) {
                        renderTimeline();
                    }
                }, 50);
                
                showToast('📊 Compare mode ON - Click ⚖️ on a user');
            } else {
                app.classList.remove('compare-mode');
                btn.classList.remove('active');
                btn.innerHTML = '📊 Compare';
                statsPanel.style.display = 'none';
                
                // Clear compare state
                compareUser = null;
                compareEvents = [];
                compareEventPositions.clear();
                
                // Re-initialize playback without compare events
                initPlayback();
                
                // Resize main canvas back
                setTimeout(() => {
                    const canvas = document.getElementById('timeline-canvas');
                    const ctx = canvas.getContext('2d');
                    const container = document.getElementById('canvas-container');
                    canvas.width = container.clientWidth;
                    canvas.height = container.clientHeight;
                    
                    // Redraw the background circle
                    drawTimelineBackground(ctx, canvas.width, canvas.height);
                    
                    if (selectedUser) {
                        renderTimeline();
                    }
                }, 50);
            }
            
            renderUserList();
        }
        
        function selectCompareUser(pubkey, event) {
            event.stopPropagation();
            
            if (!compareMode) return;
            
            // Don't allow comparing user with themselves
            if (selectedUser?.pubkey === pubkey) {
                showToast('⚠️ Select a different user to compare');
                return;
            }
            
            const user = users.find(u => u.pubkey === pubkey);
            if (!user) return;
            
            compareUser = user;
            renderUserList();
            
            // Fetch compare user's events
            fetchCompareUserEvents(pubkey);
            
            // Update compare header
            document.getElementById('compare-user-info').innerHTML = 
                `<span style="color:var(--accent2)">${user.name || user.npub.slice(0, 12)}</span>`;
        }
        
        function fetchCompareUserEvents(pubkey) {
            const container = document.getElementById('compare-nodes');
            container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
            
            compareEvents = [];
            compareEventPositions.clear();
            
            const now = Math.floor(Date.now() / 1000);
            const since = now - (timeRangeHours * 60 * 60);
            
            const subId = 'compare-events-' + Date.now();
            const filter = {
                kinds: [1],
                authors: [pubkey],
                since: since,
                limit: 500
            };
            
            let compareSeenIds = new Set();
            
            connectToMultipleRelays(subId, filter, (event) => {
                if (compareSeenIds.has(event.id)) return;
                compareSeenIds.add(event.id);
                
                const isReply = event.tags.some(t => t[0] === 'e');
                const parentEventId = event.tags.find(t => t[0] === 'e')?.[1];
                
                compareEvents.push({
                    ...event,
                    isReply,
                    parentEventId
                });
            }, () => {
                // On EOSE - render compare timeline
                renderCompareTimeline();
                updateCompareStats();
                // Re-initialize playback to include compare events
                initPlayback();
            });
        }
        
        function drawCompareBackground() {
            if (!compareCanvas || !compareCtx) return;
            
            const width = compareCanvas.width;
            const height = compareCanvas.height;
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.min(width, height) * 0.35;
            
            compareCtx.clearRect(0, 0, width, height);
            
            // Draw hour markers (same as main canvas but with accent2 color)
            for (let h = 0; h < 24; h++) {
                const angle = (h / 24) * Math.PI * 2 - Math.PI / 2;
                const innerR = radius - 10;
                const outerR = h % 6 === 0 ? radius + 20 : radius + 10;
                
                // Tick marks
                compareCtx.beginPath();
                compareCtx.moveTo(centerX + Math.cos(angle) * innerR, centerY + Math.sin(angle) * innerR);
                compareCtx.lineTo(centerX + Math.cos(angle) * outerR, centerY + Math.sin(angle) * outerR);
                compareCtx.strokeStyle = h % 6 === 0 ? '#8b5cf6' : '#2a2a3a';
                compareCtx.lineWidth = h % 6 === 0 ? 2 : 1;
                compareCtx.stroke();
                
                // Hour labels
                if (h % 3 === 0) {
                    const labelR = radius + 35;
                    const x = centerX + Math.cos(angle) * labelR;
                    const y = centerY + Math.sin(angle) * labelR;
                    compareCtx.font = '11px monospace';
                    compareCtx.fillStyle = '#555';
                    compareCtx.textAlign = 'center';
                    compareCtx.textBaseline = 'middle';
                    compareCtx.fillText(`${h}:00`, x, y);
                }
            }
            
            // Draw timeline circle
            compareCtx.beginPath();
            compareCtx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            compareCtx.strokeStyle = '#8b5cf6';
            compareCtx.lineWidth = 2;
            compareCtx.stroke();
            
            // Center dot
            compareCtx.beginPath();
            compareCtx.arc(centerX, centerY, 4, 0, Math.PI * 2);
            compareCtx.fillStyle = '#8b5cf6';
            compareCtx.fill();
        }
        
        function renderCompareTimeline() {
            if (!compareCanvas) return;
            
            const nodesContainer = document.getElementById('compare-nodes');
            nodesContainer.innerHTML = ''; // Clear existing nodes
            
            const container = document.getElementById('compare-container');
            const width = container.clientWidth;
            const height = container.clientHeight;
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.min(width, height) * 0.35;
            
            // Redraw background
            drawCompareBackground();
            
            // Clear positions
            compareEventPositions.clear();
            
            // Filter events
            const filteredEvents = compareEvents.filter(e => {
                if (viewMode === 'posts') return !e.isReply;
                if (viewMode === 'replies') return e.isReply;
                return true;
            });
            
            if (filteredEvents.length === 0) {
                nodesContainer.innerHTML = `
                    <div class="empty-state" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">
                        <div class="icon">📭</div>
                        <p>No events found</p>
                    </div>
                `;
                return;
            }
            
            // Sort by time
            filteredEvents.sort((a, b) => a.created_at - b.created_at);
            
            // Get time range for proper positioning
            const now = Math.floor(Date.now() / 1000);
            const rangeStart = now - (timeRangeHours * 60 * 60);
            
            // Render events as nodes using DOM (not innerHTML) for proper event handlers
            filteredEvents.forEach((event, index) => {
                // Calculate position based on time within range
                const timeSinceStart = event.created_at - rangeStart;
                const progress = timeSinceStart / (timeRangeHours * 60 * 60);
                const angle = progress * Math.PI * 2 - Math.PI / 2;
                
                // Deterministic radius variation
                const hash = event.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                const radiusOffset = (hash % 40) - 20;
                const r = radius + radiusOffset;
                
                const x = centerX + Math.cos(angle) * r;
                const y = centerY + Math.sin(angle) * r;
                
                // Store position
                compareEventPositions.set(event.id, { x, y });
                
                const node = document.createElement('div');
                node.className = `event-node ${event.isReply ? 'reply' : 'post'}`;
                node.style.left = x + 'px';
                node.style.top = y + 'px';
                node.dataset.eventId = event.id;
                node.title = formatTime(event.created_at) + '\n' + event.content.slice(0, 100);
                
                node.addEventListener('click', () => selectEvent(event, true));
                
                nodesContainer.appendChild(node);
            });
            
            // Draw thread lines if enabled
            if (showThreadLines) {
                renderCompareThreadLines();
            }
            
            // Update header
            document.getElementById('compare-user-info').textContent = 
                `${compareUser?.name || 'User'} — ${filteredEvents.length} events`;
        }
        
        // Keep selectCompareEvent for backward compatibility but redirect to selectEvent
        function selectCompareEvent(event) {
            if (!event) return;
            selectEvent(event, true);
        }
        
        function updateCompareStats() {
            if (!selectedUser || !compareUser) return;
            
            // User names
            document.getElementById('compare-name1').textContent = (selectedUser.name || 'User 1').slice(0, 8);
            document.getElementById('compare-name2').textContent = (compareUser.name || 'User 2').slice(0, 8);
            
            // Totals
            const total1 = userEvents.length;
            const total2 = compareEvents.length;
            document.getElementById('compare-total1').textContent = total1;
            document.getElementById('compare-total2').textContent = total2;
            updateCompareBar('compare-bar-total', total1, total2);
            
            // Posts
            const posts1 = userEvents.filter(e => !e.isReply).length;
            const posts2 = compareEvents.filter(e => !e.isReply).length;
            document.getElementById('compare-posts1').textContent = posts1;
            document.getElementById('compare-posts2').textContent = posts2;
            updateCompareBar('compare-bar-posts', posts1, posts2);
            
            // Replies
            const replies1 = userEvents.filter(e => e.isReply).length;
            const replies2 = compareEvents.filter(e => e.isReply).length;
            document.getElementById('compare-replies1').textContent = replies1;
            document.getElementById('compare-replies2').textContent = replies2;
            updateCompareBar('compare-bar-replies', replies1, replies2);
            
            // Activity score (events per hour)
            const activity1 = (total1 / timeRangeHours).toFixed(1);
            const activity2 = (total2 / timeRangeHours).toFixed(1);
            document.getElementById('compare-activity1').textContent = `${activity1}/h`;
            document.getElementById('compare-activity2').textContent = `${activity2}/h`;
        }
        
        function updateCompareBar(barId, val1, val2) {
            const bar = document.getElementById(barId);
            if (!bar) return;
            
            const total = val1 + val2;
            if (total === 0) {
                bar.querySelector('.bar-user1').style.width = '50%';
                bar.querySelector('.bar-user2').style.width = '50%';
            } else {
                bar.querySelector('.bar-user1').style.width = `${(val1 / total) * 100}%`;
                bar.querySelector('.bar-user2').style.width = `${(val2 / total) * 100}%`;
            }
        }

        // ============================================
        // NIP-07 EXTENSION LOGIN
        // ============================================
        
        function checkNip07Extension() {
            // Check if window.nostr exists (NIP-07)
            if (window.nostr) {
                console.log('NIP-07 extension detected!');
                return true;
            } else {
                console.log('No NIP-07 extension detected');
                // Update UI to show extension not found
                document.querySelector('.identity-btn.login').textContent = '🔑 No Extension Found';
                document.querySelector('.identity-btn.login').title = 'Install Alby, nos2x, or another NIP-07 extension';
                return false;
            }
        }
        
        async function loginWithExtension() {
            if (!window.nostr) {
                showToast('❌ No NIP-07 extension found. Install Alby or nos2x!');
                return;
            }
            
            try {
                showToast('🔐 Requesting permission...');
                const pubkey = await window.nostr.getPublicKey();
                
                if (!pubkey) {
                    showToast('❌ Failed to get public key');
                    return;
                }
                
                // Convert to npub
                const npub = window.NostrTools.nip19.npubEncode(pubkey);
                
                // Save identity
                currentIdentity = {
                    pubkey: pubkey,
                    npub: npub,
                    name: null,
                    picture: null
                };
                
                // Update UI
                updateIdentityUI();
                
                // Save to localStorage
                localStorage.setItem('nostr_orbit_identity', JSON.stringify(currentIdentity));
                
                // Fetch profile info
                fetchIdentityProfile(pubkey);
                
                showToast('✅ Connected successfully!');
                
            } catch (e) {
                console.error('Login error:', e);
                showToast('❌ Login cancelled or failed');
            }
        }
        
        function logout() {
            currentIdentity = null;
            localStorage.removeItem('nostr_orbit_identity');
            
            // Reset UI
            document.getElementById('identity-logged-in').style.display = 'none';
            document.getElementById('identity-logged-out').style.display = 'block';
            document.getElementById('identity-avatar').innerHTML = '👤';
            document.getElementById('identity-name').textContent = 'Not connected';
            document.getElementById('identity-npub').textContent = 'Login to import follows';
            
            showToast('👋 Disconnected');
        }
        
        function restoreIdentity() {
            const stored = localStorage.getItem('nostr_orbit_identity');
            if (stored) {
                try {
                    currentIdentity = JSON.parse(stored);
                    updateIdentityUI();
                    // Refresh profile
                    fetchIdentityProfile(currentIdentity.pubkey);
                } catch (e) {
                    console.error('Failed to restore identity:', e);
                }
            }
        }
        
        function updateIdentityUI() {
            if (!currentIdentity) return;
            
            document.getElementById('identity-logged-out').style.display = 'none';
            document.getElementById('identity-logged-in').style.display = 'block';
            document.getElementById('identity-name').textContent = currentIdentity.name || 'Loading...';
            document.getElementById('identity-npub').textContent = currentIdentity.npub.slice(0, 16) + '...';
            
            if (currentIdentity.picture) {
                document.getElementById('identity-avatar').innerHTML = `<img src="${currentIdentity.picture}" alt="avatar" onerror="this.parentElement.innerHTML='👤'">`;
            }
        }
        
        function fetchIdentityProfile(pubkey) {
            const subId = 'identity-profile-' + Date.now();
            const filter = {
                kinds: [0],
                authors: [pubkey],
                limit: 1
            };
            
            connectToMultipleRelays(subId, filter, (event) => {
                try {
                    const profile = JSON.parse(event.content);
                    if (currentIdentity && currentIdentity.pubkey === pubkey) {
                        currentIdentity.name = profile.display_name || profile.name || 'Anonymous';
                        currentIdentity.picture = profile.picture;
                        
                        // Update localStorage
                        localStorage.setItem('nostr_orbit_identity', JSON.stringify(currentIdentity));
                        
                        // Update UI
                        updateIdentityUI();
                    }
                } catch (e) {
                    console.error('Failed to parse profile:', e);
                }
            });
        }
        
        async function addMeToList() {
            if (!currentIdentity) {
                showToast('❌ Not logged in');
                return;
            }
            
            // Check if already in list
            if (users.some(u => u.pubkey === currentIdentity.pubkey)) {
                showToast('ℹ️ You are already in the list!');
                return;
            }
            
            // Add to users
            users.push({
                npub: currentIdentity.npub,
                pubkey: currentIdentity.pubkey,
                name: currentIdentity.name || 'Me',
                picture: currentIdentity.picture,
                addedAt: Date.now()
            });
            
            saveStoredUsers();
            renderUserList();
            showToast('✅ Added yourself to the list!');
        }
        
        async function importFollows() {
            if (!currentIdentity) {
                showToast('❌ Not logged in');
                return;
            }
            
            showToast('📥 Fetching your follows...');
            
            const subId = 'import-follows-' + Date.now();
            const filter = {
                kinds: [3], // Contact list
                authors: [currentIdentity.pubkey],
                limit: 1
            };
            
            let followsReceived = false;
            
            connectToMultipleRelays(subId, filter, (event) => {
                if (followsReceived) return; // Only process first event
                followsReceived = true;
                
                // Extract followed pubkeys from 'p' tags
                const followedPubkeys = event.tags
                    .filter(t => t[0] === 'p' && t[1])
                    .map(t => t[1]);
                
                if (followedPubkeys.length === 0) {
                    showToast('ℹ️ No follows found');
                    return;
                }
                
                showToast(`📥 Found ${followedPubkeys.length} follows, importing...`);
                
                // Add new follows (up to 50 to avoid overwhelming)
                let added = 0;
                const maxImport = 50;
                
                for (const pubkey of followedPubkeys) {
                    if (added >= maxImport) break;
                    
                    // Skip if already exists
                    if (users.some(u => u.pubkey === pubkey)) continue;
                    
                    try {
                        const npub = window.NostrTools.nip19.npubEncode(pubkey);
                        users.push({
                            npub: npub,
                            pubkey: pubkey,
                            name: null,
                            picture: null,
                            addedAt: Date.now()
                        });
                        added++;
                    } catch (e) {
                        console.error('Failed to encode pubkey:', e);
                    }
                }
                
                saveStoredUsers();
                renderUserList();
                
                // Fetch profiles for all new users
                fetchProfilesForNewUsers();
                
                if (added > 0) {
                    showToast(`✅ Imported ${added} follows!${followedPubkeys.length > maxImport ? ` (limited to ${maxImport})` : ''}`);
                } else {
                    showToast('ℹ️ All follows already in list');
                }
            });
        }
        
        function fetchProfilesForNewUsers() {
            // Fetch profiles for users without names
            const usersNeedingProfiles = users.filter(u => !u.name);
            if (usersNeedingProfiles.length === 0) return;
            
            const pubkeys = usersNeedingProfiles.map(u => u.pubkey);
            const subId = 'bulk-profiles-' + Date.now();
            const filter = {
                kinds: [0],
                authors: pubkeys,
                limit: pubkeys.length
            };
            
            connectToMultipleRelays(subId, filter, (event) => {
                try {
                    const profile = JSON.parse(event.content);
                    const user = users.find(u => u.pubkey === event.pubkey);
                    if (user) {
                        user.name = profile.display_name || profile.name || null;
                        user.picture = profile.picture;
                        renderUserList();
                    }
                } catch (e) {
                    console.error('Failed to parse profile:', e);
                }
            });
        }