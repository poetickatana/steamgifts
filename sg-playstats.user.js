// ==UserScript==
// @name         SteamGifts Playstats
// @namespace    sg-playstats
// @version      1.1
// @description  Scan all giveaways on a user or group page for wins by a specific user or all users and fetches Steam playtime + achievements data
// @match        https://www.steamgifts.com/group/*/*
// @match        https://www.steamgifts.com/user/*
// @exclude      https://www.steamgifts.com/group/*/*/*
// @grant        GM_xmlhttpRequest
// @connect      steamcommunity.com
// @connect      store.steampowered.com
// @connect      api.steampowered.com

// ==/UserScript==
//
// Future goals?
//    Multi-page winner scraping for giveaways with copies > 3.
//    Date cutoff for giveaway scanning. Useful for large, old groups.
//
//KNOWN ISSUES
// Assuming that a profile is private if games?.length === 0 is not safe. If a profile is marked as private due to API issues, it won't be scanned again until the cache expires.

(() => {
    'use strict';

    /************ CONFIG ************/
    const SCAN_DELAY = 1000; // ms between page fetches

    const GA_SAFETY_WINDOW_DAYS = 14; // Ignore cached data for wins younger than value (Default = 14 days)
    const STEAM_TTL_CLEANUP_INTERVAL_HOURS = 1; // Cooldown period for automatic Steam cache pruning (default = 1 hour)

    const isGroupPage = /^https:\/\/www\.steamgifts\.com\/group\/[^/]+\/[^/]+/.test(location.href);
    const isUserWonPage = /^\/user\/[^/]+\/giveaways\/won/.test(location.pathname);

    const DEFAULT_SETTINGS = {
        steamApiKey: '',
        steamConcurrency : 6, // # of parallel Steam API requests in single-user mode
        steamCacheTTLDays: 5, // Validity period of cached Steam data
        giveawayCacheSize: 50000
    }

    const settings = {
        ...DEFAULT_SETTINGS,
        ...JSON.parse(localStorage.getItem('playstats_settings') || '{}')
    };

    /************ GLOBAL UI STATE ************/
    let scanState = {
    mode: null, // 'single' | 'all' | 'group'
    summary: null,
    userMap: null,
    membersSet : null,
    activeUser: null, // username if in detail view
    userDisplay: {}, // lowercase → display casing
    userPrivate: {}
    };

    let summarySort = {
        col: null,
        asc: true
    };

    let dateFormatMDY = true; // default to MM-DD-YYYY

    let isDragging = false;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;

    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const DRAG_THRESHOLD = 5; // pixels
    const PANEL_EXPANDED_WIDTH = 700;
    const PANEL_COLLAPSED_PADDING = '0px';

    /************ UI ************/
    // 🔹 Inject summary table CSS (truncate long game titles)
    const style = document.createElement('style');
    style.textContent = `
        .sg-user-table .col-game {
            max-width: 400px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .date-toggle-wrapper {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 13px;
            color: #c7d5e0;
            white-space: nowrap;
        }

        .date-toggle-label  {
            font-weight:bold;
            font-size:13px;
            color:#c7d5e0;
        }

        .date-toggle-switch {
            position: relative;
            display: inline-block;
            /* Reduced size */
            width: 44px;
            height: 18px;
        }

        .date-toggle-slider {
            position: absolute;
            inset: 0;
            background: #555;
            border-radius: 999px;
            cursor: pointer;
            transition: background 0.3s;
        }

        .date-toggle-slider::before {
            content: "";
            position: absolute;
            /* Knob is 4px smaller than the container height to create a 2px margin */
            height: 14px;
            width: 14px;
            left: 2px;
            bottom: 2px;
            background-color: #fff; /* White knob often looks better on small switches */
            border-radius: 50%;
            transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 2;
        }

        .date-toggle-switch input:checked + .date-toggle-slider::before {
            /* (Width - Knob Width - Margins) = (44 - 14 - 4) = 26px */
            transform: translateX(26px);
        }

        .date-toggle-switch input:checked + .date-toggle-slider {
            background: #66c0f4;
        }

        .date-toggle-text {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            font-weight: 700;
            font-size: 8px;
            color: #fff;
            pointer-events: none;
            transition: opacity 0.2s;
            white-space: nowrap; /* Prevents text from wrapping */
        }

        .date-toggle-switch input:not(:checked) + .date-toggle-slider .date-mdy {
            opacity: 0; /* Using opacity: 0 for a cleaner look on small sizes */
        }

        .date-toggle-switch input:checked + .date-toggle-slider .date-dmy {
            opacity: 0;
        }

        .date-dmy {
            right: 6px;
            opacity: 1;
        }
        .date-mdy {
            left: 6px;
            opacity: 0;
        }

        /* --- Toggle Logic --- */
        .date-toggle-switch input:not(:checked) + .date-toggle-slider .date-dmy {
            opacity: 1;
        }
        .date-toggle-switch input:not(:checked) + .date-toggle-slider .date-mdy {
            opacity: 0;
        }
        .date-toggle-switch input:checked + .date-toggle-slider .date-dmy {
            opacity: 0;
        }
        .date-toggle-switch input:checked + .date-toggle-slider .date-mdy {
            opacity: 1;
        }

        .sg-pill-group {
            display: flex;
            border-radius: 999px;
            overflow: hidden;
            border: 1px solid #3b5871;
            background: #1b2838;
        }

        .sg-pill {
            padding: 6px 14px;
            font-size: 13px;
            color: #c7d5e0;
            background: transparent;
            border: none;
            cursor: pointer;
            white-space: normal;
            line-height: 1.2;
            text-align: center;
        }

        .sg-pill:not(:last-child) {
            border-right: 1px solid #3b5871;
        }

        .sg-pill.active {
            background: #66c0f4;
            color: #0b1a24;
            font-weight: 600;
        }

        .sg-pill.disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .sg-pill:not(.disabled):hover {
            background: #2a475e;
        }

        .sg-layout {
            display: grid;
            grid-template-columns: auto 1fr;
            padding: 4px 4px;
            gap: 40px;
            align-items: start;
        }

        /* LEFT COLUMN */
        .sg-left {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        #sgUser {
            min-width: 180px;
            padding: 6px;
        }
        #sgCreatorFilter {
            min-width: 180px;
            padding: 2px 4px;
            display: none;
            vertical-align: middle;
            font-size: 12px;
        }
        #sgStart {
            padding: 8px 16px;
            background: #66c0f4; /* Bright Steam Blue */
            color: #0b1a24;
            font-weight: bold;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        #sgStartNoCache {
            background: transparent;
            color: #8fb9d8;
            border: 1px solid #3b5871;
            font-size: 11px;
            padding: 4px;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.8;
        }
        #sgStartNoCache:hover {
            opacity: 1;
            background: #2a475e;
        }

        /* RIGHT COLUMN */
        .sg-right {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 12px;
        }
        .sg-options-container {
            align-items: left;
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-left: 4px;
        }

        .sg-checkbox-label {
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: #c7d5e0;
            cursor: pointer;
            white-space: nowrap;
        }

        .sg-checkbox-label input {
            margin: 0;
            width: 14px;
            height: 14px;
            cursor: pointer;
        }
        .sg-checkbox-label span {
            user-select: none;
        }
        .sg-section-title {
            font-size: 16px;
            opacity: 0.8;
        }
        .sg-info-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: #3b5871;
            color: #c7d5e0;
            font-size: 10px;
            font-weight: bold;
            cursor: help;
            margin-left: 6px;
            vertical-align: middle;
        }

        .sg-info-icon:hover {
            background: #66c0f4;
            color: #0b1a24;
        }
       .sg-collapsible-header {
           display: flex;
           align-items: center;
           justify-content: space-between;
           cursor: pointer;
           user-select: none;
           padding: 6px 8px;
           margin-top: 12px;
           background: #1f364a;
           border: 1px solid #3b5871;
           border-radius: 4px;
           font-weight: bold;
           color: #c7d5e0;
       }

       .sg-collapsible-header:hover {
           background: #2a475e;
       }

       .sg-collapsible-arrow {
           transition: transform 0.2s ease;
       }

       .sg-collapsible.open .sg-collapsible-arrow {
           transform: rotate(90deg);
       }

       .sg-collapsible-content {
           display: none;
           margin-top: 8px;
       }

       .sg-collapsible-content {
           opacity: 0.85;
       }

       .sg-collapsible-content button {
           background: #182634;
           color: #9fb7cc;
           border-color: #2f4a63;
           font-weight: normal;
       }

       .sg-collapsible-content button:hover {
           background: #223a50;
       }
       #sg-summary-table thead th {
           position: sticky;
           top: 0;
           z-index: 2;
           background: #2a475e;
       }
       #sg-user-table thead th {
           position: sticky;
           top: 0;
           z-index: 2;
           background: #2a475e;
       }
}

    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');

    panel.style = `
        position: fixed;
        top: 40px;
        right: 30px;
        width: auto;
        background: #1b2838;
        color: #c7d5e0;
        z-index: 9999;
        border-radius: 6px;
        font-size: 13px;
        max-height: calc(100vh - 80px);
        overflow-y: auto;
        overflow-x: hidden;
        box-shadow:
            0 2px 4px rgba(0, 0, 0, 0.4),
            0 6px 14px rgba(0, 0, 0, 0.55),
            inset 0 1px 0 rgba(255, 255, 255, 0.12),
            inset 0 -1px 0 rgba(0, 0, 0, 0.4);
`;

    panel.innerHTML = `
        <div id="sgHeader" style="
            padding: 8px 10px;
            background: #2a475e;
            cursor: pointer;
            font-weight: bold;
            user-select: none;
        ">
            ▶ Playstats
        </div>

        <div id="sgBody" style="padding:16px; display:none;">

            <div class="sg-layout">

                <!-- LEFT COLUMN -->
                <div class="sg-left">
                    <input id="sgUser"
                           placeholder="Winner's username">
                    <button id="sgStart">Scan</button>
                    <button id="sgStartNoCache" class="sg-secondary-btn"
                            title="Fetch fresh Steam data (ignores cache)">
                        ↻ Scan (fresh)
                    </button>
                </div>

                <!-- RIGHT COLUMN -->
                <div class="sg-right">
                    <div class="sg-pill-group" id="sgModePills">
                        <button class="sg-pill active" data-mode="single">Single user</button>
                        <button class="sg-pill" data-mode="all">All winners</button>
                        <button class="sg-pill" data-mode="group">Group members</button>
                    </div>

                    <div class="sg-options-container">
                        <label class="sg-checkbox-label" title="Limit scan to whitelist-only giveaways">
                            <input type="checkbox" id="sgWhitelistOnly">
                            <span>Whitelist-only GAs</span>
                        </label>
                        <input id="sgCreatorFilter"
                            placeholder="Filter by creator"
                            title="Filter giveaways by creator (group mode only)">
                    </div>
                </div>

            </div>

            <div id="sgStatus" style="margin-top:5px;"></div>
            <div id="sgResults"></div>

        </div>

    <div class="date-toggle-wrapper" id="sgDateToggleRow">
        <span class="date-toggle-label">Date Format</span>
        <label class="date-toggle-switch">
            <input type="checkbox" id="sgDateFormatToggle">
            <span class="date-toggle-slider">
                <span class="date-toggle-text date-dmy">DMY</span>
                <span class="date-toggle-text date-mdy">MDY</span>
            </span>
        </label>
    </div>
    `;
    document.body.appendChild(panel);

    // restore panel position
    const savedTop = localStorage.getItem('playstats_panelTop');
    const savedLeft = localStorage.getItem('playstats_panelLeft');

    if (savedTop !== null && savedLeft !== null) {
        panel.style.top = savedTop + 'px';
        panel.style.left = savedLeft + 'px';
        panel.style.right = 'auto';
    }

    const pills = document.querySelectorAll('#sgModePills .sg-pill');
    const userInput = document.getElementById('sgUser');

    const creatorInput = document.getElementById('sgCreatorFilter');

    if (window.location.pathname.includes('/group/')) {
        creatorInput.style.display = 'inline-block';
    } else {
        creatorInput.style.display = 'none';
    }

    pills.forEach(pill => {
        const mode = pill.dataset.mode;
        switch(mode) {
            case 'single':
                pill.title = "Scan single winner";
                break;
            case 'all':
                pill.title = "Scan all winners";
                break;
            case 'group':
                pill.title = "Scan all winners who are group members (only applicable to group pages)";
                break;
        }
    });

    function setMode(mode) {
        scanState.mode = mode;

        pills.forEach(p => {
            p.classList.toggle('active', p.dataset.mode === mode);
        });

        // Enable / disable username box
        const single = mode === 'single';
        userInput.disabled = !single;
        userInput.style.opacity = single ? '1' : '0.5';
    }

    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            if (pill.classList.contains('disabled')) return;
            setMode(pill.dataset.mode);
        });
    });

    (function prefillUsernameFromURL() {
        const input = document.getElementById('sgUser');
        if (!input) return;

        // Match /user/<name>/giveaways/won
        const match = location.pathname.match(/^\/user\/([^/]+)\/giveaways\/won\/?$/);
        if (!match) return;

        const usernameFromURL = match[1];

        // Only prefill if empty
        if (!input.value.trim()) {
            input.value = usernameFromURL;
        }
    })();

    /************ PANEL BUTTON FOR RESTORE ************/
    const restoreBtn = document.createElement('button');
    restoreBtn.innerText = 'Restore Last Scan Results';
    restoreBtn.style = `
        padding:4px 8px; font-size:12px; margin-bottom:6px;
        background:#2a475e; color:#fff; border:none; border-radius:4px;
        cursor:pointer;
    `;
    restoreBtn.onclick = () => {
        loadScanState();
    };

    /************ PANEL DEBUG BUTTON ************/
    const sgSettingsBtn = document.createElement('button');
    sgSettingsBtn.innerText = '⚙ Settings';
    sgSettingsBtn.title = 'Open settings';
    sgSettingsBtn.style = `
        padding:4px 6px;
        font-size:12px;
        margin-left:6px;
        background:#1f364a;
        color:#c7d5e0;
        border:1px solid #3b5871;
        border-radius:4px;
        cursor:pointer;
    `;

    const topControls = document.createElement('div');
    topControls.style = `
        display:flex;
        justify-content:space-between;
        padding:1px 0px;
        align-items:center;
        margin-bottom:6px;
    `;

    const settingsPanel = document.createElement('div');
    settingsPanel.style = `
        display:none;
        margin-top:6px;
        padding:20px;
        background:#16232f;
        border:1px solid #3b5871;
        border-radius:6px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
        font-size:12px;
    `;

    panel.querySelector('#sgBody').prepend(settingsPanel);

    // Move date toggle into settings panel
    const dateToggleRow = document.getElementById('sgDateToggleRow');
    if (dateToggleRow) {
        settingsPanel.appendChild(dateToggleRow);
    }

    topControls.appendChild(restoreBtn);
    topControls.appendChild(sgSettingsBtn);

    function makeSettingsButton(label, title, onClick) {
        const btn = document.createElement('button');
        btn.innerText = label;
        btn.title = title;
        btn.style = `
            width:100%;
            padding:6px;
            margin-bottom:6px;
            background:#1f364a;
            color:#c7d5e0;
            border:1px solid #3b5871;
            border-radius:4px;
            cursor:pointer;
            text-align:left;
            font-weight:bold;
            font-size:12px;
            font-family:"Motiva Sans", Sans-Serif;
        `;
        btn.onclick = onClick;
        return btn;
    }

    function makeSettingsHeader(text) {
        const label = document.createElement('div');
        label.textContent = text;
        label.style = `
        font-weight: bold;
        font-family: 'Motiva Sans', Sans-Serif;
        font-size: 16px;
        margin-bottom: 6px;
        margin-top: 12px;
        color: #67c1f5;
        `;
        return label;
    }

    function makeDebugSubHeader(text) {
        const h = document.createElement('div');
        h.textContent = text;
        h.style = `
            font-size: 13px;
            font-weight: bold;
            margin: 10px 0 6px;
            color: #9fb7cc;
            opacity: 0.85;
        `;
        return h;
    }

    function makeSettingInput(label, key, helpText, min = 1, max = 5) {
        const wrap = document.createElement('div');
        wrap.style = 'margin-bottom:12px;';

        const labelRow = document.createElement('div');
        labelRow.style = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;';

        // Left side: Label + Icon
        const labelContainer = document.createElement('div');
        labelContainer.style = 'display:flex; align-items:center;';

        const title = document.createElement('span');
        title.textContent = label;
        title.style = `font-weight:bold;
                       font-size:13px;
                       color:#c7d5e0;`
        ;

        const infoIcon = document.createElement('span');
        infoIcon.className = 'sg-info-icon';
        infoIcon.textContent = 'i';
        infoIcon.title = helpText; // The tooltip lives on the icon

        labelContainer.appendChild(title);
        labelContainer.appendChild(infoIcon);

        // Right side: Input
        const input = document.createElement('input');
        input.type = 'number';
        input.min = min;
        input.max = max;
        input.value = settings[key];
        input.style = `
            width:46px;
            padding:2px 4px;
            background:#1b2838;
            color:#66c0f4;
            border:1px solid #3b5871;
            border-radius:4px;
            font-size:13px;
            text-align:center;
        `;

        input.addEventListener('change', () => {
            let v = parseInt(input.value);
            if (isNaN(v) || v < min) v = min;
            if (v > max) v = max;
            input.value = v;
            settings[key] = v;
            localStorage.setItem('playstats_settings', JSON.stringify(settings));
        });

        labelRow.appendChild(labelContainer);
        labelRow.appendChild(input);
        wrap.appendChild(labelRow);

        return wrap;
    }

    function makeSettingsTextInput(label, key, helpText, placeholder = '') {
        const wrap = document.createElement('div');
        wrap.style = 'margin-bottom:12px;';

        const labelRow = document.createElement('div');
        labelRow.style = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;';

        const labelContainer = document.createElement('div');
        labelContainer.style = 'display:flex; align-items:center;';

        const title = document.createElement('span');
        title.textContent = label;
        title.style = 'font-weight:bold; font-size:13px; color:#c7d5e0;';

        const infoIcon = document.createElement('span');
        infoIcon.className = 'sg-info-icon';
        infoIcon.textContent = 'i';
        infoIcon.title = helpText;

        labelContainer.appendChild(title);
        labelContainer.appendChild(infoIcon);

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = placeholder;
        input.value = settings[key] || '';
        input.style = `
            width: 180px;
            padding: 4px 8px;
            background: #1b2838;
            color: #66c0f4;
            border: 1px solid #3b5871;
            border-radius: 4px;
            font-size: 12px;
        `;

        input.addEventListener('change', () => {
            settings[key] = input.value.trim();
            localStorage.setItem('playstats_settings', JSON.stringify(settings));
        });

        labelRow.appendChild(labelContainer);
        labelRow.appendChild(input);
        wrap.appendChild(labelRow);

        return wrap;
    }

    function makeCollapsibleSection(title, storageKey) {
        const container = document.createElement('div');
        container.className = 'sg-collapsible';

        const header = document.createElement('div');
        header.className = 'sg-collapsible-header';

        const titleRow = document.createElement('div');
        titleRow.className = 'sg-collapsible-title-row';

        const label = document.createElement('span');
        label.textContent = title;

        const arrow = document.createElement('span');
        arrow.className = 'sg-collapsible-arrow';
        arrow.textContent = '▶';

        titleRow.appendChild(label);
        titleRow.appendChild(arrow);

        header.appendChild(titleRow);

        const content = document.createElement('div');
        content.className = 'sg-collapsible-content';

        const saved = localStorage.getItem(storageKey) === 'true';
        if (saved) {
            container.classList.add('open');
            content.style.display = 'block';
        }

        header.onclick = () => {
            const open = container.classList.toggle('open');
            content.style.display = open ? 'block' : 'none';
            localStorage.setItem(storageKey, open);
        };

        container.appendChild(header);
        container.appendChild(content);

        return { container, content };
    }

    settingsPanel.appendChild(makeSettingsHeader('Steam Credentials'));

    settingsPanel.appendChild(
        makeSettingsTextInput(
            'Steam API Key',
            'steamApiKey',
            'Required to fetch achievement and playtime data. You can get one from the Steam Community website https://steamcommunity.com/dev/apikey',
            'Paste key here...'
        )
    );

    const credSeparator = document.createElement('div');
    credSeparator.style = "height: 1px; background: #3b5871; margin: 10px 0; opacity: 0.5;";
    settingsPanel.appendChild(credSeparator);

    settingsPanel.appendChild(makeSettingsHeader('Steam Performance'));

    settingsPanel.appendChild(
        makeSettingInput(
            'Steam Scan Speed (2-10)',
            'steamConcurrency',
            'Sets the balance between speed and safety. Lower values are slower but safer; higher values are faster but may trigger Steam\'s anti-spam filters. Default: 6.',
            2, 10
        )
    );

    settingsPanel.appendChild(
        makeSettingInput(
            'Cache Expiry (days)',
            'steamCacheTTLDays',
            'Number of days Steam data stays in your local cache before it is considered "stale" and needs a fresh download.',
            1, 90
        )
    );

    const separator = document.createElement('div');
        separator.style = "height: 1px; background: #3b5871; margin: 10px 0; opacity: 0.5;";
        settingsPanel.appendChild(separator);

    const debugSection = makeCollapsibleSection(
        'Advanced / Debug Tools',
        'playstats_debug_open'
    );

    settingsPanel.appendChild(debugSection.container);

    debugSection.content.appendChild(
        makeSettingsTextInput(
            'Giveaway Cache Size',
            'giveawayCacheSize',
            'Maximum number of giveaways that can be stored in cache (Default = 50000). If exceeded, the least recently used cached page gets evicted.\n\nEach giveaway entry uses ~250-300 bytes, so a 50,000 entries will occupy ~12MB.',
            '50000'
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            'Show Cache Disk Usage',
            'Show Playstats cache storage usage in console',
            () => debugShowCacheStorageFootprint()
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            'Show Giveaway Cache Contents',
            'Log giveaway cache contents to console',
            () => debugShowGiveawayCache()
        )
    );

    const separator2 = document.createElement('div');
    separator2.style = "height: 1px; background: #3b5871; margin: 10px 0; opacity: 0.5;";
    debugSection.content.appendChild(separator2)

    debugSection.content.appendChild(makeDebugSubHeader('Clear Caches'));

    debugSection.content.appendChild(
        makeSettingsButton(
            'Giveaway Cache [Current Page]',
            'Clear giveaway cache for current page',
            () => {
                if (!confirm('Clear giveaway cache for this page?')) return;
                clearGiveawayCacheForCurrentUrl();
                status('Cleared cache for current group.');
            }
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            'Giveaway Cache [All Pages]',
            'Clear ALL giveaway caches',
            () => {
                if (!confirm('Clear ALL giveaway caches? This cannot be undone.')) return;
                clearAllGiveawayCaches();
                status('All giveaway caches cleared.');
            }
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            'Steam Cache',
            'Clear ALL Steam playtime and achievement data',
            () => {
                if (!confirm('Clear ALL Steam cache data? This cannot be undone.')) return;
                clearSteamIDBCache();
                status('All Steam data cleared.');
            }
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            'Subid Mapping Cache',
            'Clear the subid -> app mapping cache. Only necessary if subid contents change.',
            () => {
                if (!confirm('Clear subid cache?')) return;
                clearSubIDBCache();
                status('Cleared subid mapping cache.');
            }
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            ' SteamID Cache',
            'Clear the cache holding user steamid values.',
            () => {
                if (!confirm('Clear steamid cache?')) return;
                localStorage.getItem(`playstats_steamid_map`);
                status('Cleared steamid cache.');
            }
        )
    );

    sgSettingsBtn.onclick = () => {
        const open = settingsPanel.style.display === 'block';
        settingsPanel.style.display = open ? 'none' : 'block';
    };

    // Sync Checkbox States to Logic
    const whitelistCheck = document.getElementById('sgWhitelistOnly');

    whitelistCheck.addEventListener('change', () => {
        // Update your whitelist logic here if needed
        // e.g., scanState.whitelistOnly = whitelistCheck.checked;
    });

    panel.querySelector('#sgBody').prepend(topControls);

    const dateToggle = document.getElementById('sgDateFormatToggle');

    // Load saved state from localStorage (default to true if not set)
    const savedDateFormat = localStorage.getItem('playstats_dateFormat');
    dateToggle.checked = savedDateFormat !== null ? JSON.parse(savedDateFormat) : dateFormatMDY;

    // Set the variable to match saved state
    dateFormatMDY = dateToggle.checked;

    dateToggle.addEventListener('change', () => {
        dateFormatMDY = dateToggle.checked;

        // Save to localStorage
        localStorage.setItem('playstats_dateFormat', JSON.stringify(dateFormatMDY));

        // Re-render tables if needed
        if (scanState.activeUser) {
            showUserDetail(scanState.activeUser);
        } else if (scanState.summary) {
            renderSummary(scanState.summary, scanState.membersSet);
        }
    });

    if (!isGroupPage) {
        document
            .querySelector('.sg-pill[data-mode="group"]')
            .classList.add('disabled');
    }

    if (isUserWonPage) {
        document.querySelectorAll('.sg-pill[data-mode="all"], .sg-pill[data-mode="group"]')
            .forEach(el => el.classList.add('disabled'));
    }

    const header = document.getElementById('sgHeader');
    const body = document.getElementById('sgBody');
    const resultsWrap = document.getElementById('sgResults');

    let expanded = false;

    // initial collapsed state
    body.style.display = 'none';
    panel.style.width = 'fit-content';
    panel.style.padding = PANEL_COLLAPSED_PADDING;

    header.addEventListener('click', (e) => {
        if (dragMoved) {
            // This was a drag, not a click → do nothing
            dragMoved = false;
            return;
        }
        expanded = !expanded;
        body.style.display = expanded ? 'block' : 'none';
        if (expanded) {
            panel.style.width = PANEL_EXPANDED_WIDTH + 'px';
        } else {
            panel.style.width = 'fit-content';
        }
        header.innerText = (expanded ? '▼ ' : '▶ ') + 'Playstats';
    });

    // panel drag logic
    header.addEventListener('mousedown', e => {
        isDragging = true;
        dragMoved = false;
        startX = e.clientX;
        startY = e.clientY;

        const rect = panel.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;

        panel.style.right = 'auto'; // detach from right anchor
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!isDragging) return;

        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);

        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
            dragMoved = true;
        }

        if (!dragMoved) return;

        panel.style.left = (e.clientX - dragOffsetX) + 'px';
        panel.style.top  = (e.clientY - dragOffsetY) + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;

        isDragging = false;

        const rect = panel.getBoundingClientRect();
        localStorage.setItem('playstats_panelTop', Math.round(rect.top));
        localStorage.setItem('playstats_panelLeft', Math.round(rect.left));
    });

    const status = msg => document.getElementById('sgStatus').innerText = msg;

    /************ HELPERS ************/
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function fetchPage(url) {
        return fetch(url, { credentials: 'include' }).then(r => r.text());
    }

    function parseHTML(html) {
        return new DOMParser().parseFromString(html, 'text/html');
    }

    function isWhitelistOnlyGiveaway(g) {
        const hasWhitelist = !!g.querySelector('.giveaway__column--whitelist');
        const hasGroup = !!g.querySelector('.giveaway__column--group');
        return hasWhitelist && !hasGroup;
    }

    function formatDateFromTimestamp(ts) {
        if (!ts) return 'N/A';

        const d = new Date(ts * 1000);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();

        return dateFormatMDY
            ? `${month}-${day}-${year}`
            : `${day}-${month}-${year}`;
    }

    function getGiveawayId({ url, name, ts }) {
        if (url) return url;
        // invite-only fallback
        return `invite:${name}|${ts}`;
    }

    function gmFetchText(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: r => resolve(r.responseText),
                onerror: reject,
                onabort: reject,
                ontimeout: reject
            });
        });
    }

    async function isApiKeyValid(key) {
        if (!key || key.length !== 32) return false;

        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v1/?key=${key}&steamids=76561197960435530`,
                onload: (r) => {
                    // Steam returns 200 OK if the key is valid,
                    // and 403 Forbidden if the key is invalid or unauthorized.
                    resolve(r.status === 200);
                },
                onerror: () => resolve(false)
            });
        });
    }

    async function runWithConcurrency(items, limit, worker) {
        const queue = [...items];
        const workers = [];

        for (let i = 0; i < limit; i++) {
            workers.push((async function run() {
                while (queue.length) {
                    const item = queue.shift();
                    // Measure how long the worker takes
                    const start = performance.now();
                    await worker(item);
                    const elapsed = performance.now() - start;

                    if (queue.length > 0) {
                        // If it took > 10ms, it hit the network. Give it a 50ms breather.
                        // If it was faster, it was a cache hit. Give it 1ms just to keep UI smooth.
                        const delay = elapsed > 10 ? 50 : 1;
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
            })());
        }

        await Promise.all(workers);
    }

    // ****** RENDER HELPERS ******* //
    function computeUserStats(wins) {
        let eligible = 0;
        let gamesAnyCompletion = 0;
        let games25Completion = 0;

        let totalUnlocked = 0;
        let totalAvailable = 0;

        let totalHours = 0;
        let anyHours = 0;
        let avgHours = 0;

        for (const w of wins) {
            totalHours += w.hours ?? 0;
            if (w.hours) anyHours++;

            if (!w.ach || !w.ach.includes('/')) continue;

            const [done, total] = w.ach.split('/').map(Number);
            if (!total || isNaN(done) || isNaN(total)) continue;

            eligible++;

            const pct = (done / total) * 100;

            if (pct > 0) gamesAnyCompletion++;
            if (pct >= 25) games25Completion++;

            if (done > 0) {
                totalUnlocked += done;
                totalAvailable += total;
            }
        }

        return {
            gamesWon: wins.length,
            eligible,

            gamesAnyCompletion,
            games25Completion,

            pctAnyCompletion: eligible
                ? Math.round((gamesAnyCompletion / eligible) * 100)
                : 0,

            pct25Completion: eligible
                ? Math.round((games25Completion / eligible) * 100)
                : 0,

            compPct: totalAvailable
                ? Math.round((totalUnlocked / totalAvailable) * 100)
                : 0,

            totalHours: totalHours / 60,

            anyHours: anyHours,

            avgHours: anyHours
                ? Math.trunc((totalHours / 60) / anyHours * 100) / 100
                : 0
        };
    }

    async function exportTableToCSV(table, suggestedName) {
        const rows = Array.from(table.querySelectorAll('tr'));
        const csv = rows.map(row => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            return cells.map(cell => {
                let text = cell.innerText
                    .replace(/\s+/g, ' ')
                    .trim()
                    .replace(/🔒/g, 'PRIVATE')
                    .replace(/"/g, '""');
                return `"${text}"`;
            }).join(',');
        }).join('\n');

        // --- Preferred: native Save As dialog (Chromium browsers)
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName,
                    types: [{
                        description: 'CSV file',
                        accept: { 'text/csv': ['.csv'] }
                    }]
                });

                const writable = await handle.createWritable();
                await writable.write(csv);
                await writable.close();
                return;
            } catch (err) {
                // User canceled → silently ignore
                return;
            }
        }

        // --- Fallback: auto-download (Firefox, older browsers)
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /******** SUB RESOLUTION HELPERS ********/
    function parseSubAppsFromHTML(html) {
        const doc = parseHTML(html);
        const apps = [];

        for (const el of doc.querySelectorAll('.tab_item')) {
            const appid = el.getAttribute('data-ds-appid');
            const href = el.querySelector('.tab_item_overlay')?.href;

            if (!appid || !href) continue;
            if (!/\/app\//.test(href)) continue; // skip DLC

            apps.push(Number(appid));
        }

        return apps;
    }

    async function getSubAppsCached(subid) {
        const cached = await idbGet('subs', subid);
        if (cached && Array.isArray(cached.apps)) {
            return cached.apps; // empty array is valid
        }
        const html = await gmFetchText(`https://store.steampowered.com/sub/${subid}`);
        let apps = parseSubAppsFromHTML(html);
        if (!apps.length) {
            console.log(`Sub ${subid} has no apps (likely removed or bundle shell)`);
            apps = [];
            await idbSet('subs', subid, {
                ts: Date.now() / 1000,
                apps
            });
            return apps;
        }
        await idbSet('subs', subid, {
            ts: Date.now() / 1000,
            apps
        });

        return apps;
    }

    //************ CACHE HELPERS ************/
    function getGaPath() {
        return location.pathname.replace(/\/$/, '');
    }

    async function loadGiveawayCache() {
        const path = getGaPath();
        const entry = await gaGet(path);
        if (!entry) return null;

        // Touch entry (LRU)
        entry.ts = Math.floor(Date.now() / 1000);
        await gaSet(path, entry);

        return entry;
    }

    async function saveGiveawayCache(data) {
        await gaSet(getGaPath(), data);
        enforceGaLRULimit(); // fire-and-forget
    }

    async function debugShowGiveawayCache() {
        const db = await openGaDB();
        const entries = [];

        await new Promise(resolve => {
            const tx = db.transaction('pages', 'readonly');
            const store = tx.objectStore('pages');
            const req = store.openCursor();

            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor) return resolve();

                const v = cursor.value;
                entries.push({
                    path: cursor.key,
                    count: v.giveaways?.length ?? 0,
                    lastCacheUpdate: v.lastCacheUpdate,
                    updated: new Date(v.lastCacheUpdate * 1000).toLocaleString()
                });

                cursor.continue();
            };
        });

        if (!entries.length) {
            console.log('[Playstats Cache] No giveaway cache entries.');
            return;
        }

        console.table(entries);
    }

    async function clearGiveawayCacheForCurrentUrl() {
        await gaDelete(getGaPath());
        console.log('[Playstats Cache] Cleared GA cache for', getGaPath());
    }

    async function clearAllGiveawayCaches() {
        await gaClearAll();
        console.log('[Playstats Cache] Cleared ALL giveaway caches');
    }

    async function clearSteamIDBCache() {
        const db = await openSteamDB();
        //const tx = db.transaction(['ownedGames', 'achievements'], 'readwrite');
        const tx = db.transaction(['ownedGames', 'achievements', 'subs'], 'readwrite');
        tx.objectStore('ownedGames').clear();
        tx.objectStore('achievements').clear();
        tx.objectStore('subs').clear();
        return new Promise(res => tx.oncomplete = res);
    }

    async function clearSubIDBCache() {
        const db = await openSteamDB();
        const tx = db.transaction(['subs'], 'readwrite');
        tx.objectStore('subs').clear();
        return new Promise(res => tx.oncomplete = res);
    }

    async function debugShowCacheStorageFootprint() {
    function sizeOf(value) {
        if (value == null) return 0;
        try {
            return new Blob([JSON.stringify(value)]).size;
        } catch {
            return 0;
        }
    }

    function fmt(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    console.groupCollapsed(
        '%c[Playstats] Cache Storage Footprint',
        'color:#7fbfff;font-weight:bold'
    );

    /* ---------------- SteamID cache (localStorage) ---------------- */

    const key = 'playstats_steamid_map';
    const data = localStorage.getItem(key);

    // Each character in JS is 2 bytes (UTF-16)
    const bytes = data.length * 2;
    const kb = (bytes / 1024).toFixed(2);
    const entries = Object.keys(JSON.parse(data)).length;

    console.log(`SteamID cache (localStorage): ${entries} entries (${fmt(bytes)})`);

    /* ---------------- Giveaway cache (IndexedDB) ---------------- */

    async function getGaCacheStats() {
        const db = await openGaDB();

        let pages = 0;
        let gaCount = 0;
        let bytes = 0;

        await new Promise(resolve => {
            const tx = db.transaction('pages', 'readonly');
            const store = tx.objectStore('pages');
            const req = store.openCursor();

            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor) return resolve();

                pages++;

                const v = cursor.value;
                const list = v.giveaways ?? [];

                gaCount += list.length;

                try {
                    bytes += new Blob([JSON.stringify(v)]).size;
                } catch {}

                cursor.continue();
            };
        });

        return { pages, gaCount, bytes };
    }

    const ga = await getGaCacheStats();

    console.log(
        `Giveaway cache (IndexedDB): ${fmt(ga.bytes)} ` +
        `(${ga.pages} pages, ${ga.gaCount} GAs` +
        (ga.pages ? `, avg ${(ga.gaCount / ga.pages).toFixed(0)}/page` : '') +
        ')'
    );

    /* ---------------- Steam cache (IndexedDB) ---------------- */

    let steamOwnedBytes = 0;
    let steamAchBytes = 0;
    let ownedCount = 0;
    let achCount = 0;

    try {
        const db = await openSteamDB();

        // ownedGames
        await new Promise(resolve => {
            const tx = db.transaction('ownedGames', 'readonly');
            const store = tx.objectStore('ownedGames');
            const req = store.openCursor();

            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor) return resolve();

                steamOwnedBytes += sizeOf(cursor.value);
                ownedCount++;
                cursor.continue();
            };
        });

        // achievements
        await new Promise(resolve => {
            const tx = db.transaction('achievements', 'readonly');
            const store = tx.objectStore('achievements');
            const req = store.openCursor();

            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor) return resolve();

                steamAchBytes += sizeOf(cursor.value);
                achCount++;
                cursor.continue();
            };
        });

        const steamTotal = steamOwnedBytes + steamAchBytes;

        console.log('Steam cache (IndexedDB total):', fmt(steamTotal));
        console.log(' ├─ ownedGames:', fmt(steamOwnedBytes), `(${ownedCount} users)`);
        console.log(' └─ achievements:', fmt(steamAchBytes), `(${achCount} entries)`);

        console.log(
            'TOTAL Playstats storage:',
            fmt(ga.bytes + steamTotal)
        );

    } catch (e) {
        console.warn('[Playstats] Failed to inspect Steam IndexedDB cache:', e);
    }

    console.groupEnd();
}

    /************ STEAM ID ************/
    async function getSteamID(username) {
        const CACHE_NAME = 'playstats_steamid_map';
        const userLower = username.toLowerCase();

        // 1. Load the entire map from localStorage
        let idMap = {};
        try {
            idMap = JSON.parse(localStorage.getItem(CACHE_NAME)) || {};
        } catch (e) {
            idMap = {};
        }

        // 2. Check if the user exists in our map
        if (idMap[userLower]) {
            return idMap[userLower];
        }

        // 3. Not in cache, fetch from SteamGifts
        const html = await fetchPage(`https://www.steamgifts.com/user/${username}`);
        await sleep(SCAN_DELAY);
        const doc = parseHTML(html);
        const steamLink = doc.querySelector('a[href*="steamcommunity.com"]');
        if (!steamLink) throw 'Steam profile not found';

        const url = steamLink.href;
        let steamid;

        if (url.includes('/profiles/')) {
            steamid = url.split('/profiles/')[1].replace(/\D/g, '');
        } else if (url.includes('/id/')) {
            const vanity = url.split('/id/')[1].replace('/', '');
            steamid = await resolveVanity(vanity);
        } else {
            throw 'Unknown Steam profile format';
        }

        // 4. Update the map and save it back to the single key
        idMap[userLower] = steamid;
        localStorage.setItem(CACHE_NAME, JSON.stringify(idMap));

        return steamid;
    }

    function resolveVanity(vanity) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${settings.steamApiKey}&vanityurl=${vanity}`,
                onload: r => {
                    const data = JSON.parse(r.responseText);
                    data.response.success === 1
                        ? resolve(data.response.steamid)
                        : reject('Vanity resolution failed');
                }
            });
        });
    }

    /************ GROUP SCAN ************/
    async function fetchDoc(url) {
        const html = await fetch(url, { credentials: 'include' }).then(r => r.text());
        return new DOMParser().parseFromString(html, 'text/html');
    }

    async function discoverLastPage(baseUrl) {
        let page = 1;
        let last = 1;

        while (true) {
            const doc = await fetchDoc(`${baseUrl}?page=${page}`);
            const pages = [...doc.querySelectorAll('.pagination__navigation a')]
                .map(a => parseInt(a.textContent.trim(), 10))
                .filter(n => !isNaN(n));

            if (!pages.length) break;

            const max = Math.max(...pages);
            if (max <= last) break;

            last = max;
            page = max;
        }

        return last;
    }

    /************ GA SCAN ************/
    async function scanGiveaways() {
        status('Scanning giveaways…');

        const base = location.href.split('?')[0];
        const cache = await loadGiveawayCache();
        const cachedGiveaways = cache?.giveaways || [];
        const lastCacheUpdate = cache?.lastCacheUpdate || 0;
        const now = Math.floor(Date.now() / 1000);

        let forcedWinner = null;
        if (isUserWonPage) {
            forcedWinner = location.pathname
                .split('/user/')[1]
                .split('/')[0]
                .toLowerCase();
        }

        let maxPage = 1;

        // ESGST fast path
        const esgstLastPageLink = document.querySelector('.esgst-page-link-last');
        if (esgstLastPageLink) {
            const match = esgstLastPageLink.href.match(/page=(\d+)/);
            if (match) maxPage = Number(match[1]);
        }

        // Group fast path
        const elements = document.querySelectorAll('a:has(.fa-angle-double-right)');

        const groupLastPageLink = Array.from(elements).find(el =>
          el.textContent.includes('Last')
        );

        if (groupLastPageLink) {
            maxPage = groupLastPageLink.getAttribute('data-page-number');
        }

        if (maxPage === 1) {
            maxPage = await discoverLastPage(base);
        }

        const newlyScanned = [];
        let stopScanning = false;

        for (let page = 1; page <= maxPage && !stopScanning; page++) {
            status(`Scanning page ${page}/${maxPage}`);
            const doc = await fetchDoc(`${base}?page=${page}`);

            const rows = doc.querySelectorAll('.giveaway__row-inner-wrap');

            for (const g of rows) {
                const name = g.querySelector('.giveaway__heading__name')?.textContent.trim();
                const url  = g.querySelector('.giveaway__heading__name')?.href || null;

                const appLink = g.querySelector('a[href*="/app/"], a[href*="/sub/"]')?.href;
                let app = null;
                let sub = null;

                if (appLink) {
                    const appMatch = appLink.match(/\/app\/(\d+)/);
                    const subMatch = appLink.match(/\/sub\/(\d+)/);

                    if (appMatch) app = Number(appMatch[1]);
                    if (subMatch) sub = Number(subMatch[1]);
                }

                const tsEl = g.querySelector('span[data-timestamp]');
                const ts = tsEl ? Number(tsEl.dataset.timestamp) : null;
                const wlonly = isWhitelistOnlyGiveaway(g);

                const creatorEl = g.querySelector('.giveaway__column--width-fill a[href^="/user/"]');
                const creator = creatorEl
                    ? creatorEl.textContent.trim().toLowerCase()
                    : null;

                let winners;

                if (forcedWinner) {
                    winners = [forcedWinner];
                } else {
                    winners = [...g.querySelectorAll('.giveaway__column--positive a[href^="/user/"]')]
                        .map(a => {
                            const name = a.textContent.trim();
                            scanState.userDisplay[name.toLowerCase()] ??= name;
                            return name.toLowerCase();
                        });
                }

                if (!winners.length || !ts) continue;


                if (ts < now - GA_SAFETY_WINDOW_DAYS * 24 * 60 * 60) {
                    if (ts <= lastCacheUpdate) {
                        stopScanning = true;
                        break;
                    }
                }

                const gid = getGiveawayId({ url, name, ts });

                newlyScanned.push({ gid, name, url, app, sub, isSub: !!sub, ts, wlonly, creator, winners });
            }

            await sleep(SCAN_DELAY);
        }

        // Merge: newest wins override older cached ones
        // Build a fast lookup set from newly scanned giveaway IDs
        const newIds = new Set(newlyScanned.map(g => g.gid));

        const merged = [
            ...newlyScanned,
            ...cachedGiveaways.filter(c => !newIds.has(c.gid))
        ];

        await saveGiveawayCache({
            lastCacheUpdate: now,
            giveaways: merged
        });

        return merged;
    }

    function showUserDetail(username) {
        // Remove any visible table first
        resultsWrap.querySelector('table')?.remove();
        resultsWrap.querySelector('#dismiss-table')?.remove();
        resultsWrap.querySelector('#write-csv')?.remove();
        resultsWrap.querySelector('#back-to-summary')?.remove();

        scanState.activeUser = username;
        const wins = scanState.userMap[username];
        if (!wins) return;

        const stats = computeUserStats(wins);

        document.getElementById('sgStatus').innerHTML = `
            <b>Showing detailed results for
            <a href="https://www.steamgifts.com/user/${scanState.userDisplay[username] ?? username}"
               target="_blank"
               style="color:#66c0f4;text-decoration:underline;">
                ${scanState.userDisplay[username] ?? username}
            </a></b><br>

            🎮 <b>${stats.gamesAnyCompletion}</b> / ${stats.eligible}
            games (<b>${stats.pctAnyCompletion}%</b>) have <b>&gt;0%</b> completion<br>

            🏆 <b>${stats.games25Completion}</b> / ${stats.eligible}
            games (<b>${stats.pct25Completion}%</b>) have <b>≥25%</b> completion<br>

            ⭐ Avg. Game Completion Rate: <b>${stats.compPct}%</b><br>

            ⏱️ Games with any Playtime: <b>${stats.anyHours}</b><br>

            ⏰ Avg. Game Playtime: <b>${stats.avgHours}</b>
        `;

         if (scanState.userPrivate[username]) {
             document.getElementById('sgStatus').innerHTML +=
                 `<br>🔒 <b>Steam profile is private</b>`;
         }

        render(wins);

        if (scanState.mode === 'all' || scanState.mode === 'group') {
            addBackToSummaryButton();
        }
    }

    function addBackToSummaryButton() {
        let btn = document.getElementById('back-to-summary');
        if (btn) return;

        btn = document.createElement('button');
        btn.id = 'back-to-summary';
        btn.innerText = '← Back to Summary';
        btn.style = `
            margin-top: 10px;
            margin-bottom: 6px;
            padding: 4px 8px;
            font-size: 12px;
            background:#2a475e;
            color:#fff;
            border:none;
            border-radius:4px;
            cursor:pointer;
        `;

        btn.onclick = () => {
            scanState.activeUser = null;
            renderSummary(scanState.summary, scanState.membersSet);
            status(`Summary loaded for ${scanState.summary.length} users.`);
            btn.remove();
        };

        resultsWrap.prepend(btn);
    }

    /************ PERSISTENCE HELPERS ************/
    function saveScanState() {
        try {
            localStorage.setItem('playstats_summary', JSON.stringify(scanState.summary));
            localStorage.setItem('playstats_userMap', JSON.stringify(scanState.userMap));
            localStorage.setItem('playstats_membersSet', JSON.stringify([...scanState.membersSet || []]));
            localStorage.setItem('playstats_mode', scanState.mode);
            localStorage.setItem('playstats_activeUser', scanState.activeUser || '');
            localStorage.setItem('playstats_userDisplay', JSON.stringify(scanState.userDisplay));
        } catch (e) {
            console.warn('Failed to save scan state', e);
        }
    }

    function loadScanState() {
        try {
            const summary = JSON.parse(localStorage.getItem('playstats_summary') || 'null');
            const userMap = JSON.parse(localStorage.getItem('playstats_userMap') || 'null');
            const members = JSON.parse(localStorage.getItem('playstats_membersSet') || '[]');
            const mode = localStorage.getItem('playstats_mode') || null;
            const activeUser = localStorage.getItem('playstats_activeUser') || null;
            const userDisplay = JSON.parse(localStorage.getItem('playstats_userDisplay') || '[]');

            scanState.summary = summary;
            scanState.userMap = userMap;
            scanState.membersSet = members;
            scanState.mode = mode;
            scanState.activeUser = activeUser;
            scanState.userDisplay = userDisplay;

            if (scanState.mode === 'single' && scanState.activeUser) {
                showUserDetail(scanState.activeUser);
                status(`Restored last scan for ${scanState.activeUser}.`);
                return;
            }

            if (summary && userMap) {
                renderSummary(summary, scanState.membersSet);
                status(`Restored last scan for ${summary.length} users.`);
            }
        } catch (e) {
            console.warn('Failed to load scan state', e);
        }
    }

    function clearResults() {
        // Remove all tables in resultsWrap
        resultsWrap.querySelectorAll('table').forEach(t => t.remove());
        // Remove any dismiss buttons
        resultsWrap.querySelectorAll('#dismiss-table, #back-to-summary, #write-csv').forEach(b => b.remove());
    }

    /************ RENDER SUMMARY ************/
    function renderSummary(summary, membersSet = new Set()) {
        // Remove any visible table first
        resultsWrap.querySelector('table')?.remove();
        resultsWrap.querySelector('#dismiss-table')?.remove();
        resultsWrap.querySelector('#write-csv')?.remove();
        resultsWrap.querySelector('#back-to-summary')?.remove();

        const dismissBtn = document.createElement('button');
        dismissBtn.id = 'dismiss-table';
        dismissBtn.innerText = '✖';
        dismissBtn.title = 'Dismiss summary';
        dismissBtn.style = `
            float: right;
            margin-bottom: 5px;
            padding: 2px 6px;
            font-size: 12px;
            background:#2a475e;
            color:#fff;
            border:none;
            border-radius:3px;
            cursor:pointer;
        `;
        dismissBtn.onclick = () => {
            resultsWrap.querySelector('table')?.remove();
            dismissBtn.remove();
            status('');
        };
        resultsWrap.appendChild(dismissBtn);

        const csvBtn = document.createElement('button');
            csvBtn.id = 'write-csv';
            csvBtn.innerText = 'CSV';
            csvBtn.title = 'Export table to CSV';
            csvBtn.style = `
                float: right;
                margin-bottom: 5px;
                margin-right: 5px;
                padding: 2px 6px;
                font-size: 12px;
                background:#2a475e;
                color:#fff;
                border:none;
                border-radius:3px;
                cursor:pointer;
            `;

            csvBtn.onclick = async () => {
                const table = document.getElementById('sg-summary-table');
                if (table) {
                    exportTableToCSV(table, `steamgifts-summary-${new Date().toISOString().slice(0,10)}.csv`);
                }
            };

        resultsWrap.appendChild(csvBtn);

        const table = document.createElement('table');
        table.style = `
            width: 100%;
            margin-top: 10px;
            border-collapse: collapse;
            table-layout: fixed;
            text-align: center;
            white-space: nowrap;
        `;
        table.id = 'sg-summary-table';

        const colgroup = document.createElement('colgroup');
        colgroup.innerHTML = `
           <col style="width: 22%">
           <col style="width: 12%">
           <col style="width: 12%">
           <col style="width: 9%">
           <col style="width: 12%">
           <col style="width: 9%">
           <col style="width: 10%">
           <col style="width: 14%">
        `;
        table.appendChild(colgroup);

        const headers = ['User','Games Won','Games >0%','% >0','Games ≥25','% ≥25','Comp %','Total Hours'];
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        headers.forEach((h,i) => {
            const th = document.createElement('th');
            th.innerText = h;
            th.style = 'cursor:pointer;padding:6px;background:#2a475e;color:#fff;border:1px solid #444;';
            th.onclick = () => sortTable(table, i);
            trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        summary.forEach(u => {
            const tr = document.createElement('tr');
            // Highlight group members
            /*if (membersSet && membersSet.has(u.username.toLowerCase())) {
                tr.style.backgroundColor = '#284b35';
            }*/

            const tdUser = document.createElement('td');
            tdUser.style = 'padding:6px;border:1px solid #444;text-align:left;';
            const a = document.createElement('a');
            a.href = '#';
            a.onclick = (e) => { e.preventDefault(); showUserDetail(u.username); };
            a.innerText = scanState.userDisplay[u.username] ?? u.username;
            tdUser.appendChild(a);
            tr.appendChild(tdUser);

            const cols = ['gamesWon','gamesAnyCompletion','pctAnyCompletion','games25Completion','pct25Completion','compPct','totalHours'];
            cols.forEach(c => {
                const td = document.createElement('td');
                td.style = 'padding:6px;border:1px solid #444;';

                const isPrivate = !!scanState.userPrivate[u.username];
                let val = (!isPrivate || c === 'gamesWon')
                    ? (u[c] ?? 0)
                    : '🔒';

                // Set the sorting/data value
                td.dataset.value = (isPrivate && c !== 'gamesWon') ? -1 : (u[c] ?? -1);

                if (c === 'totalHours' && typeof val === 'number') {
                    val = val.toFixed(1);
                }

                td.innerText = val;

                // 3. Append percentage sign if applicable
                if (!isPrivate && (c === 'pctAnyCompletion' || c === 'pct25Completion' || c === 'compPct')) {
                    td.innerText += '%';
                }
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        resultsWrap.appendChild(table);

        // Apply last sort
        if (summarySort.col !== null) {
            sortTable(table, summarySort.col, summarySort.asc);
        }

        // Save to localStorage
        saveScanState();
    }

    /***********************
     * Giveaway IndexedDB
     ***********************/
    const GA_DB_NAME = 'playstats-ga-cache';
    const GA_DB_VERSION = 1;

    let gaDbPromise = null;

    function openGaDB() {
        if (gaDbPromise) return gaDbPromise;

        gaDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(GA_DB_NAME, GA_DB_VERSION);

            req.onupgradeneeded = () => {
                const db = req.result;

                if (!db.objectStoreNames.contains('pages')) {
                    db.createObjectStore('pages'); // key = pathname
                }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        return gaDbPromise;
    }

    async function gaGet(path) {
        const db = await openGaDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pages', 'readonly');
            const req = tx.objectStore('pages').get(path);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    async function gaSet(path, value) {
        const db = await openGaDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pages', 'readwrite');
            tx.objectStore('pages').put({
                ...value,
                path,
                ts: Math.floor(Date.now() / 1000)
            }, path);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }

    async function gaDelete(path) {
        const db = await openGaDB();
        return new Promise(resolve => {
            const tx = db.transaction('pages', 'readwrite');
            tx.objectStore('pages').delete(path);
            tx.oncomplete = resolve;
        });
    }

    async function gaClearAll() {
        const db = await openGaDB();
        return new Promise(resolve => {
            const tx = db.transaction('pages', 'readwrite');
            tx.objectStore('pages').clear();
            tx.oncomplete = resolve;
        });
    }

    // LRU eviction
    async function enforceGaLRULimit(maxTotal = settings.giveawayCacheSize) {
        const db = await openGaDB();

        const pages = [];
        let total = 0;

        // Collect pages
        await new Promise(resolve => {
            const tx = db.transaction('pages', 'readonly');
            const store = tx.objectStore('pages');
            const req = store.openCursor();

            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor) return resolve();

                const v = cursor.value;
                const count = v.giveaways?.length ?? 0;

                pages.push({
                    path: cursor.key,
                    ts: v.ts ?? 0,
                    count
                });

                total += count;
                cursor.continue();
            };
        });

        if (total <= maxTotal) return;

        // Evict least-recently-used pages first
        pages.sort((a, b) => a.ts - b.ts);

        let evicted = 0;

        const tx = db.transaction('pages', 'readwrite');
        const store = tx.objectStore('pages');

        for (const p of pages) {
            if (total <= maxTotal) break;

            store.delete(p.path);
            total -= p.count;
            evicted += p.count;
        }

        await new Promise(resolve => (tx.oncomplete = resolve));

        console.log(
            `[Playstats Cache] GA LRU eviction: removed ${evicted} giveaways, remaining ${total}`
        );
    }

    /***********************
     * Steam IndexedDB
     ***********************/
    const STEAM_DB_NAME = 'playstats-steam-cache';
    const STEAM_DB_VERSION = 2;
    //const GA_MAX_TOTAL = 50_000; // total giveaways across all pages

    let steamDbPromise = null;

    function openSteamDB() {
        if (steamDbPromise) return steamDbPromise;

        steamDbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(STEAM_DB_NAME, STEAM_DB_VERSION);

            req.onupgradeneeded = () => {
                const db = req.result;

                if (!db.objectStoreNames.contains('ownedGames')) {
                    db.createObjectStore('ownedGames'); // key = steamid
                }
                if (!db.objectStoreNames.contains('achievements')) {
                    db.createObjectStore('achievements'); // key = steamid_appid
                }
                if (!db.objectStoreNames.contains('subs')) {
                    db.createObjectStore('subs'); // key = subid
               }
            };

            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        return steamDbPromise;
    }

    async function idbGet(storeName, key) {
        const db = await openSteamDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbSet(storeName, key, value) {
        const db = await openSteamDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            store.put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    let lastSteamTTLCleanup = 0;

    async function idbDelete(storeName, key) {
        const db = await openSteamDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            store.delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function idbIterate(storeName, callback) {
        const db = await openSteamDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const req = store.openCursor();

            req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                    resolve();
                    return;
                }

                callback(cursor.value, cursor.key);
                cursor.continue();
            };

            req.onerror = () => reject(req.error);
        });
    }

    async function cleanupSteamCacheTTL() {
        const now = Date.now() / 1000;

        if (now - lastSteamTTLCleanup < STEAM_TTL_CLEANUP_INTERVAL_HOURS * 60 * 60) {
            return;
        }
        lastSteamTTLCleanup = now;

        async function cleanupStore(storeName) {
            const toDelete = [];

            await idbIterate(storeName, (value, key) => {
                if (!value?.ts) return;
                if (now - value.ts > settings.steamCacheTTLDays * 24 * 60 * 60) {
                    toDelete.push(key);
                }
            });

            for (const key of toDelete) {
                await idbDelete(storeName, key);
            }
        }

        await cleanupStore('ownedGames');
        await cleanupStore('achievements');
    }

    /************ STEAM DATA ************/
    function getOwnedGames(steamid) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${settings.steamApiKey}&steamid=${steamid}&include_appinfo=true`,
                onload: r => resolve(JSON.parse(r.responseText).response.games || [])
            });
        });
    }

    function getAchievements(steamid, appid) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${settings.steamApiKey}&steamid=${steamid}&appid=${appid}`,
                onload: r => {
                    const data = JSON.parse(r.responseText);
                    if (!data.playerstats?.achievements) return resolve('N/A');
                    const total = data.playerstats.achievements.length;
                    const done = data.playerstats.achievements.filter(a => a.achieved).length;
                    resolve(`${done}/${total}`);
                }
            });
        });
    }

    function isFresh(ts) {
        return (Date.now() / 1000 - ts) < settings.steamCacheTTLDays * 24 * 60 * 60;
    }

    async function getOwnedGamesCachedIDB(steamid, useSteamCache) {
        if (useSteamCache) {
            const entry = await idbGet('ownedGames', steamid);
            if (entry && isFresh(entry.ts)) {
                return { apps: entry.apps, private: !!entry.private };
            }
        }

        const games = await getOwnedGames(steamid);

        // Assume privacy if games is null or empty
        if (!games?.length) {
            await idbSet('ownedGames', steamid, {
                ts: Date.now() / 1000,
                apps: {},
                private: true
            });
            return { apps: {}, private: true };
        }

        const apps = {};
        for (const g of games) {
            apps[g.appid] = g.playtime_forever ?? 0;
        }

        // Always write-through
        await idbSet('ownedGames', steamid, {
            ts: Date.now() / 1000,
            apps,
            private: false
        });

        return { apps, private: false };
    }

    async function getAchievementsCachedIDB(steamid, appid, useSteamCache) {
        const key = `${steamid}_${appid}`;

        if (useSteamCache) {
            const entry = await idbGet('achievements', key);
            if (entry && isFresh(entry.ts)) {
                return entry.val;
            }
        }

        const val = await getAchievements(steamid, appid);

        await idbSet('achievements', key, {
            ts: Date.now() / 1000,
            val
        });

        return val;
    }

    async function getSubPlaytime(steamid, subid, useSteamCache) {
        const apps = await getSubAppsCached(subid);
        const result = await getOwnedGamesCachedIDB(steamid, useSteamCache);

        let total = 0;

        const steamGamesMap = result.apps || {};

        for (const appid of apps) {
            const time = Number(steamGamesMap[appid]) || 0;
            total += time;
        }
        return total;
    }

    async function getSubAchievements(steamid, subid, useSteamCache) {
    const apps = await getSubAppsCached(subid);
    let done = 0;
    let total = 0;

    for (const appid of apps) {
        const val = await getAchievementsCachedIDB(steamid, appid, useSteamCache);

        // 1. Strict Guard: Must be a string AND contain a slash
        if (typeof val !== 'string' || !val.includes('/')) {
            continue;
        }

        const parts = val.split('/').map(Number);

        // 2. NaN Check: Ensure map(Number) actually produced numbers
        if (isNaN(parts[0]) || isNaN(parts[1])) {
            continue;
        }

        done += parts[0];
        total += parts[1];
    }

    return total > 0 ? `${done}/${total}` : 'N/A';
}

    /************ TABLE ************/
    function sortTable(table, colIndex, forceAsc = null) {
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.rows);

        // Determine sort order
        let asc;
        if (forceAsc !== null) {
            asc = forceAsc;
        } else {
            asc = table.dataset.sortCol == colIndex
                ? table.dataset.sortAsc !== 'true'
                : true;
        }

        rows.sort((a, b) => {
            const ca = a.cells[colIndex];
            const cb = b.cells[colIndex];

            const va = ca.dataset.value;
            const vb = cb.dataset.value;

            // Numeric column
            if (va !== undefined && vb !== undefined) {
                const na = Number(va);
                const nb = Number(vb);

                if (na === nb) return 0;
                if (na < 0) return 1; // push N/A to bottom
                if (nb < 0) return -1;

                return asc ? na - nb : nb - na;
            }

            // Text fallback
            return asc
                ? ca.innerText.localeCompare(cb.innerText)
                : cb.innerText.localeCompare(ca.innerText);
        });

        rows.forEach(r => tbody.appendChild(r));
        table.dataset.sortCol = colIndex;
        table.dataset.sortAsc = asc;

        // Remember summary sort
        if (table.id === 'sg-summary-table') {
            summarySort.col = colIndex;
            summarySort.asc = asc;
        }
    }

    function render(results) {
        clearResults();

        const dismissBtn = document.createElement('button');
        dismissBtn.id = 'dismiss-table';
        dismissBtn.innerText = '✖';
        dismissBtn.title = 'Dismiss results';
        dismissBtn.style = `
            float: right;
            margin-bottom: 5px;
            padding: 2px 6px;
            font-size: 12px;
            background:#2a475e;
            color:#fff;
            border:none;
            border-radius:3px;
            cursor:pointer;
        `;
        dismissBtn.onclick = () => {
            panel.querySelector('table')?.remove();
            dismissBtn.remove();
            csvBtn.remove();
            status('');
        };
        resultsWrap.appendChild(dismissBtn);

        const csvBtn = document.createElement('button');
            csvBtn.id = 'write-csv';
            csvBtn.innerText = 'CSV';
            csvBtn.title = 'Export table to CSV';
            csvBtn.style = `
                float: right;
                margin-bottom: 5px;
                margin-right: 5px;
                padding: 2px 6px;
                font-size: 12px;
                background:#2a475e;
                color:#fff;
                border:none;
                border-radius:3px;
                cursor:pointer;
            `;

            csvBtn.onclick = async () => {
                const table = document.getElementById('sg-user-table');
                if (table) {
                    exportTableToCSV(table, `steamgifts-user-${new Date().toISOString().slice(0,10)}.csv`);
                }
            };

            resultsWrap.appendChild(csvBtn);

        const table = document.createElement('table');
        table.style = `
            width: 100%;
            margin-top: 10px;
            border-collapse: collapse;
            table-layout: fixed;
            text-align: center;
            white-space: nowrap;
        `;

        table.id = 'sg-user-table';

        const colgroup = document.createElement('colgroup');

        colgroup.innerHTML = `
            <col style="width: 45%">  <!-- Game -->
            <col style="width: 15%">  <!-- Date -->
            <col style="width: 15%">  <!-- Achievements -->
            <col style="width: 15%">  <!-- Completion % -->
            <col style="width: 10%">  <!-- Hours -->
        `;

        table.appendChild(colgroup);

        table.classList.add('sg-user-table');

        // Column headers
        const headers = ['Game', 'Date', 'Achievements', 'Completion %', 'Hours'];
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        headers.forEach((h, i) => {
            const th = document.createElement('th');
            th.innerText = h;
            th.style = 'cursor: pointer; padding: 6px; background: #2a475e; color: #fff; border: 1px solid #444;';
            th.onclick = () => sortTable(table, i);
            trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        table.appendChild(thead);

        // Table body
        const tbody = document.createElement('tbody');
        results.forEach(r => {
            const tr = document.createElement('tr');

            // Game name (wider, nowrap with ellipsis if too long)
            const tdName = document.createElement('td');
            tdName.className = 'col-game';
            tdName.style = 'padding: 6px; border:1px solid #444; text-align: left;';

            if (r.url) {
                // If URL exists, create a link
                const a = document.createElement('a');
                a.href = r.url;
                a.target = '_blank';
                a.style = 'color:#66c0f4; text-decoration:none;';
                a.innerText = r.name;
                tdName.appendChild(a);
            } else {
                tdName.innerText = r.name + ' 🔒';
                tdName.style.color = '#888';
            }

            tr.appendChild(tdName);

            // Date (convert timestamp to MM/DD/YYYY)
            const tdDate = document.createElement('td');
            tdDate.style = 'padding: 6px; border:1px solid #444;';
            tdDate.innerText = formatDateFromTimestamp(r.ts);
            tdDate.dataset.value = r.ts ?? -1; // 👈 numeric sort value
            tr.appendChild(tdDate);

            // Achievements
            const tdAch = document.createElement('td');
            tdAch.style = 'padding: 6px; border:1px solid #444;';

            if (r.ach && r.ach.includes('/') && r.app) {
                const [done, total] = r.ach.split('/').map(Number);

                const a = document.createElement('a');
                a.href = `https://steamcommunity.com/profiles/${r.steamid}/stats/${r.app}/achievements`;
                a.target = '_blank';
                a.style = 'color:#66c0f4; text-decoration:none;';
                a.innerText = r.ach;

                tdAch.appendChild(a);
                tdAch.dataset.value = done / total;
            } else {
                tdAch.innerText = r.ach || 'N/A';
                tdAch.dataset.value = -1;
            }

            tr.appendChild(tdAch);

            // Completion %
            const tdComp = document.createElement('td');
            tdComp.style = 'padding: 6px; border:1px solid #444;';
            if (r.ach && r.ach.includes('/')) {
                const [done, total] = r.ach.split('/').map(Number);
                const pct = total > 0 ? Math.round((done / total) * 100) : -1;
                tdComp.innerText = pct >= 0 ? pct + '%' : 'N/A';
                tdComp.dataset.value = pct;
            } else {
                tdComp.innerText = 'N/A';
            }
            tr.appendChild(tdComp);

            // Hours (convert from minutes to hours, 1 decimal)
            const tdHours = document.createElement('td');
            tdHours.style = 'padding: 6px; border:1px solid #444;';
            const hours = r.hours !== undefined ? Number(r.hours)/60 : 0;
            tdHours.innerText = hours.toFixed(1);   // display 1 decimal
            tdHours.dataset.value = hours;          // numeric value in hours for sorting
            tr.appendChild(tdHours);

            // Highlight whitelist only giveaways
            if (r.wlonly) tr.style.backgroundColor = '#0d5c94';

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        resultsWrap.appendChild(table);
    }

    /************ GROUP MEMBERSHIP ************/
    async function fetchGroupMembers() {
        const members = new Set();

        // Fetch page 1 first
        const html = await fetchPage(location.href.split('?')[0] + '/users/search?page=1');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        // Grab members from page 1
        const userEls = doc.querySelectorAll('.table__rows a.table__column__heading[href^="/user/"]');
        userEls.forEach(el => members.add(el.textContent.replace(/\s+/g, ' ').trim().toLowerCase()));
        // Find total pages
        const paginationLinks = doc.querySelectorAll('.pagination__navigation a[data-page-number]');
        const pageNumbers = Array.from(paginationLinks).map(a => parseInt(a.dataset.pageNumber));
        const lastPage = pageNumbers.length ? Math.max(...pageNumbers) : 1;
        if (lastPage <= 1) return members; // only 1 page

        // Fetch remaining pages
        for (let page = 2; page <= lastPage; page++) {
            // SG uses `/search?page=N` for pages > 1
            const pageHtml = await fetchPage(location.href.split('?')[0] + '/users/search?page=' + page);
            const pageDoc = new DOMParser().parseFromString(pageHtml, 'text/html');

            const userElsPage = pageDoc.querySelectorAll('.table__rows a.table__column__heading[href^="/user/"]');
            userElsPage.forEach(el => members.add(el.textContent.replace(/\s+/g, ' ').trim().toLowerCase()));
        }
        return members;
    }

    /************ STEAM PROGRESS ************/
    function initSteamProgress(total) {
        let box = document.getElementById('steam-progress');
        if (box) box.remove();

        box = document.createElement('div');
        box.id = 'steam-progress';
        box.style = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            background: #1b2838;
            color: #c7d5e0;
            padding: 10px;
            border: 1px solid #3c6e91;
            border-radius: 6px;
            width: 260px;
            font-size: 13px;
            z-index: 99999;
        `;

        box.innerHTML = `
            <div id="steam-progress-text">Fetching Steam data… 0 / ${total}</div>
            <div style="background:#0e1621; height:8px; margin-top:6px; border-radius:4px;">
                <div id="steam-progress-bar" style="height:8px; width:0%; background:#66c0f4; border-radius:4px;"></div>
            </div>
        `;

        document.body.appendChild(box);
    }

    function updateSteamProgress(done, total) {
        const text = document.getElementById('steam-progress-text');
        const bar = document.getElementById('steam-progress-bar');
        if (!text || !bar) return;

        text.textContent = `Fetching Steam data… ${done} / ${total}`;
        bar.style.width = `${Math.round((done / total) * 100)}%`;
    }

    function finishSteamProgress() {
        const box = document.getElementById('steam-progress');
        if (box) {
            box.querySelector('#steam-progress-text').textContent = 'Steam data complete ✔';
            setTimeout(() => box.remove(), 1500);
        }
    }

    function getCompletionPercent(ach) {
        if (!ach || !ach.includes('/')) return null;
        const [done, total] = ach.split('/').map(Number);
        if (!total || isNaN(done) || isNaN(total)) return null;
        return (done / total) * 100;
    }

    setMode('single');

    function buildUserMap(giveaways, mode, username, membersSet) {
        const map = {};

        for (const g of giveaways) {
            for (const u of g.winners) {

                // 🔒 mode-based inclusion
                if (mode === 'single') {
                    if (u !== username.toLowerCase()) continue;
                }

                if (mode === 'group') {
                    if (!membersSet || !membersSet.has(u.toLowerCase())) continue;
                }

                (map[u] ??= []).push({
                    name: g.name,
                    url: g.url,
                    app: g.app,
                    sub: g.sub,
                    isSub: g.isSub,
                    wlonly: g.wlonly,
                    ts: g.ts
                });
            }
        }

        return map;
    }

    /************ MAIN ************/
    const runScan = async (useSteamCache) => {
        try {
            const mode = scanState.mode;
            const whitelistOnly = document.getElementById('sgWhitelistOnly').checked;
            const username = userInput.value.trim();
            scanState.userDisplay[username.toLowerCase()] ??= username;
            const creatorFilter = creatorInput.value.trim().toLowerCase();

            if (!settings.steamApiKey) {
                status('❌ Error: Steam API Key is missing in settings.');
                return;
            }

            const isValid = await isApiKeyValid(settings.steamApiKey);
            if (!isValid) {
                status('❌ Error: Invalid Steam API Key. Please check your settings.');
                return;
            }

            if (mode === 'single' && !username) {
                status('Enter a username');
                return;
            }

            resultsWrap.innerHTML = '';

            if (useSteamCache) {
                status(`Scanning giveaways...`);
            } else {
                status(`Scanning giveaways (fresh)...`);
            }

            /* -------------------------------------------------
               Unified scan for all modes
            ------------------------------------------------- */
            const wins = await scanGiveaways();

            /* -------------------------------------------------
               Whitelist-only giveaway filtering
            ------------------------------------------------- */
            let filteredWins = wins;

            if (whitelistOnly) {
                filteredWins = filteredWins.filter(g => g.wlonly);
            }

            /* -------------------------------------------------
               Creator giveaway filtering
            ------------------------------------------------- */
            if (scanState.mode === 'group' && creatorFilter) {
                filteredWins = filteredWins.filter(g => g.creator === creatorFilter);
            }

            /* -------------------------------------------------
               User-mode winner filtering
            ------------------------------------------------- */
            let membersSet = null;

            if (mode === 'group') {
                status('Fetching group members...');
                membersSet = await fetchGroupMembers();
            }

            if (!filteredWins.length) {
                status('No matching giveaways found');
                return;
            }

            let userMap = buildUserMap(filteredWins, mode, username, membersSet);

            const usernames = Object.keys(userMap);
            const totalUsers = usernames.length;

            if (totalUsers === 0) {
                status('No matching winners found');
                return;
            }

            /* -------------------------------------------------
               Fetch Steam data
            ------------------------------------------------- */
            status('Fetching Steam data...');

            let processedUsers = 0;
            await cleanupSteamCacheTTL();

            for (const [user, userWins] of Object.entries(userMap)) {
                status(`Fetching Steam data for ${scanState.userDisplay[user] ?? user} (${++processedUsers}/${totalUsers})...`);

                let steamid;
                try {
                    steamid = await getSteamID(user);
                } catch {
                    continue;
                }

                userWins.forEach(w => w.steamid = steamid);

                let steamGamesMap = {};
                let isPrivate = false;

                const res = await getOwnedGamesCachedIDB(steamid, useSteamCache);
                steamGamesMap = res.apps;
                isPrivate = !!res.private;

                scanState.userPrivate[user] = isPrivate;

                if (isPrivate) {
                    userWins.forEach(w => {
                        w.hours = null;
                        w.ach = null;
                    });
                    continue; // skip Steam processing for this user
                }

                initSteamProgress(userWins.length);
                let done = 0;

                // Worker that processes ONE win
                async function processWin(w) {
                    if (w.isSub && w.sub) {
                        try {
                            w.hours = await getSubPlaytime(steamid, w.sub, useSteamCache);
                            w.ach = await getSubAchievements(steamid, w.sub, useSteamCache);
                        } catch {
                            w.hours = 0;
                            w.ach = 'N/A';
                        }
                    } else {
                        w.hours = steamGamesMap[w.app] ?? 0;
                        try {
                            w.ach = await getAchievementsCachedIDB(steamid, w.app, useSteamCache);
                        } catch {
                            w.ach = 'N/A';
                        }
                    }

                    updateSteamProgress(++done, userWins.length);
                }

                // Run with limited concurrency (SAFE + FAST)
                const concurrency = settings.steamConcurrency;
                //const steamConcurrency =
                //    mode === 'single' ? settings.steamConcurrencyFast : settings.steamConcurrencySlow;

                await runWithConcurrency(userWins, concurrency, processWin);

                finishSteamProgress();

                // Between users delay
                //if (mode !== 'single') await sleep(20);
            }

            /* -------------------------------------------------
               Render results
            ------------------------------------------------- */
            scanState.userMap = userMap;
            scanState.membersSet = membersSet;
            scanState.activeUser = null;

            if (mode === 'single') {
                scanState.summary = null;
                scanState.activeUser = username.toLowerCase();
                scanState.userMap = userMap;
                scanState.membersSet = null;

                saveScanState();
                showUserDetail(scanState.activeUser);
                return;
            }

            // Multi-user summary
            const summary = Object.entries(userMap).map(([user, wins]) => {
                const stats = computeUserStats(wins);

                return {
                    username: user,
                    ...stats
                };
            });

            summary.sort((a, b) => a.username.localeCompare(b.username));

            scanState.summary = summary;
            renderSummary(summary, membersSet);
            status(`Loaded ${summary.length} users`);

        } catch (err) {
            console.error('[Playstats]', err);
            status('Scan failed — see console');
        }
    };
    document.getElementById('sgStart').onclick = () => runScan(true);
    document.getElementById('sgStartNoCache').onclick = () => runScan(false);
})();

