// ==UserScript==
// @name         SteamGifts Playstats
// @namespace    sg-playstats
// @version      1.10.8
// @updateURL    https://github.com/poetickatana/steamgifts/raw/refs/heads/main/sg-playstats.user.js
// @downloadURL  https://github.com/poetickatana/steamgifts/raw/refs/heads/main/sg-playstats.user.js
// @description  Scan all giveaways on a user or group page for wins by a specific user or all users and fetches Steam playtime + achievements data
// @match        https://www.steamgifts.com/group/*/*
// @match        https://www.steamgifts.com/user/*
// @exclude      https://www.steamgifts.com/group/*/*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      steamcommunity.com
// @connect      store.steampowered.com
// @connect      api.steampowered.com

// ==/UserScript==
//
//
//KNOWN ISSUES
// Assuming that a profile is private if games?.length === 0 is not safe. If a profile is marked as private due to API issues, it won't be scanned again until the cache expires.

(() => {
    'use strict';

    /************ CONFIG ************/
    const SCAN_DELAY = 500; // ms between page fetches

    const GA_SAFETY_WINDOW_DAYS = 14; // Ignore cached data for wins younger than value (Default = 14 days)
    const STEAM_TTL_CLEANUP_INTERVAL_HOURS = 1; // Cooldown period for automatic Steam cache pruning (default = 1 hour)

    const isGroupPage = /^https:\/\/www\.steamgifts\.com\/group\/[^/]+\/[^/]+/.test(location.href);
    const isUserWonPage = /^\/user\/[^/]+\/giveaways\/won/.test(location.pathname);
    const ESGST_BATCH_SIZE = 400;
    const ESGST_CACHE_KEY = 'esgst_cv_cache_v1';
    const ESGST_CACHE_TTL = 24 * 60 * 60; // seconds
    const STEAM_META_BATCH_SIZE = 10;
    const STEAM_META_CACHE_KEY = 'steam_meta_cache_v1';
    const STEAM_META_CACHE_TTL = 30 * 24 * 60 * 60; // 1 month in seconds

    const DEFAULT_SETTINGS = {
        steamApiKey: '',
        steamConcurrency : 6, // # of parallel Steam API requests in single-user mode
        steamCacheTTLDays: 5, // Validity period of cached Steam data
        giveawayCacheSize: 50000
    }

    const PROFILE_STATS_MODE_KEY = 'playstats_profile_stats_mode';

    let profileStatsMode =
        localStorage.getItem(PROFILE_STATS_MODE_KEY) || 'compact';

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
    userPrivate: {},
    showMissingOnly: false
    };

    let summarySort = {
        col: null,
        asc: true
    };

    let dateFormatMDY = true; // default to MM-DD-YYYY
    let highlightWLON = false; // default to OFF
    let playrateStartedON = false;
    let ignoreDlcON = true; // default to ON
    let excludeMissingON = false; // default to OFF

    let isDragging = false;
    let dragMoved = false;
    let startX = 0;
    let startY = 0;

    let dragOffsetX = 0;
    let dragOffsetY = 0;

    const DRAG_THRESHOLD = 5; // pixels
    const PANEL_EXPANDED_WIDTH = 800;
    const PANEL_COLLAPSED_PADDING = '0px';

    /************ UI ************/
    // 🔹 Inject summary table CSS (truncate long game titles)
    const style = document.createElement('style');
    style.textContent = `
        .featured__outer-wrap {
            background-size: 100% 100%;
        }
        .sg-user-table .col-game {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .sg-creator-field {
           display:flex;
           align-items:center;
        }
        .sg-creator-field span {
            min-width:120px;
            white-space:nowrap;
        }
        .date-toggle-wrapper {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
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

        .annotate-toggle-wrapper {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 12px;
            font-size: 13px;
            color: #c7d5e0;
            white-space: nowrap;
        }

        .annotate-toggle-label  {
            font-weight:bold;
            font-size:13px;
            color:#c7d5e0;
        }

        .highlightwl-toggle-wrapper {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
            justify-content: space-between;
            font-size: 13px;
            color: #c7d5e0;
            white-space: nowrap;
        }

        .highlightwl-toggle-label  {
            font-weight:bold;
            font-size:13px;
            color:#c7d5e0;
        }

        .highlightwl-toggle-switch {
            position: relative;
            display: inline-block;
            /* Reduced size */
            width: 44px;
            height: 18px;
        }

        .highlightwl-toggle-slider {
            position: absolute;
            inset: 0;
            background: #555;
            border-radius: 999px;
            cursor: pointer;
            transition: background 0.3s;
        }

        .highlightwl-toggle-slider::before {
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

        .highlightwl-toggle-switch input:checked + .highlightwl-toggle-slider::before {
            /* (Width - Knob Width - Margins) = (44 - 14 - 4) = 26px */
            transform: translateX(26px);
        }

        .highlightwl-toggle-switch input:checked + .highlightwl-toggle-slider {
            background: #66c0f4;
        }

        .highlightwl-toggle-text {
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

        .highlightwl-toggle-switch input:not(:checked) + .highlightwl-toggle-slider .highlightwl-off {
            opacity: 0; /* Using opacity: 0 for a cleaner look on small sizes */
        }

        .highlightwl-toggle-switch input:checked + .highlightwl-toggle-slider .highlightwl-on {
            opacity: 0;
        }

        .highlightwl-off {
            right: 6px;
            opacity: 1;
        }
        .highlightwl-on {
            left: 6px;
            opacity: 0;
        }

        /* --- Toggle Logic --- */
        .highlightwl-toggle-switch input:not(:checked) + .highlightwl-toggle-slider .highlightwl-off {
            opacity: 1;
        }
        .highlightwl-toggle-switch input:not(:checked) + .highlightwl-toggle-slider .highlightwl-on {
            opacity: 0;
        }
        .highlightwl-toggle-switch input:checked + .highlightwl-toggle-slider .highlightwl-off {
            opacity: 0;
        }
        .highlightwl-toggle-switch input:checked + .highlightwl-toggle-slider .highlightwl-on {
            opacity: 1;
        }

        .playratestarted-toggle-wrapper {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
            justify-content: space-between;
            font-size: 13px;
            color: #c7d5e0;
            white-space: nowrap;
        }

        .playratestarted-toggle-label  {
            font-weight:bold;
            font-size:13px;
            color:#c7d5e0;
        }

        .playratestarted-toggle-switch {
            position: relative;
            display: inline-block;
            /* Reduced size */
            width: 44px;
            height: 18px;
        }

        .playratestarted-toggle-slider {
            position: absolute;
            inset: 0;
            background: #555;
            border-radius: 999px;
            cursor: pointer;
            transition: background 0.3s;
        }

        .playratestarted-toggle-slider::before {
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

        .playratestarted-toggle-switch input:checked + .playratestarted-toggle-slider::before {
            /* (Width - Knob Width - Margins) = (44 - 14 - 4) = 26px */
            transform: translateX(26px);
        }

        .playratestarted-toggle-switch input:checked + .playratestarted-toggle-slider {
            background: #66c0f4;
        }

        .playratestarted-toggle-text {
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

        .playratestarted-toggle-switch input:not(:checked) + .playratestarted-toggle-slider .playratestarted-off {
            opacity: 0; /* Using opacity: 0 for a cleaner look on small sizes */
        }

        .playratestarted-toggle-switch input:checked + .playratestarted-toggle-slider .playratestarted-on {
            opacity: 0;
        }

        .playratestarted-off {
            right: 6px;
            opacity: 1;
        }
        .playratestarted-on {
            left: 6px;
            opacity: 0;
        }

        /* --- Toggle Logic --- */
        .playratestarted-toggle-switch input:not(:checked) + .playratestarted-toggle-slider .playratestarted-off {
            opacity: 1;
        }
        .playratestarted-toggle-switch input:not(:checked) + .playratestarted-toggle-slider .playratestarted-on {
            opacity: 0;
        }
        .playratestarted-toggle-switch input:checked + .playratestarted-toggle-slider .playratestarted-off {
            opacity: 0;
        }
        .playratestarted-toggle-switch input:checked + .playratestarted-toggle-slider .playratestarted-on {
            opacity: 1;
        }

        .ignoredlc-toggle-wrapper {
            display: flex;
            align-items: center;
            margin-bottom: 12px;
            justify-content: space-between;
            font-size: 13px;
            color: #c7d5e0;
            white-space: nowrap;
        }

        .ignoredlc-toggle-label  {
            font-weight:bold;
            font-size:13px;
            color:#c7d5e0;
        }

        .ignoredlc-toggle-switch {
            position: relative;
            display: inline-block;
            /* Reduced size */
            width: 44px;
            height: 18px;
        }

        .ignoredlc-toggle-slider {
            position: absolute;
            inset: 0;
            background: #555;
            border-radius: 999px;
            cursor: pointer;
            transition: background 0.3s;
        }

        .ignoredlc-toggle-slider::before {
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

        .ignoredlc-toggle-switch input:checked + .ignoredlc-toggle-slider::before {
            /* (Width - Knob Width - Margins) = (44 - 14 - 4) = 26px */
            transform: translateX(26px);
        }

        .ignoredlc-toggle-switch input:checked + .ignoredlc-toggle-slider {
            background: #66c0f4;
        }

        .ignoredlc-toggle-text {
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

        .ignoredlc-toggle-switch input:not(:checked) + .ignoredlc-toggle-slider .ignoredlc-off {
            opacity: 0; /* Using opacity: 0 for a cleaner look on small sizes */
        }

        .ignoredlc-toggle-switch input:checked + .ignoredlc-toggle-slider .ignoredlc-on {
            opacity: 0;
        }

        .ignoredlc-off {
            right: 6px;
            opacity: 1;
        }
        .ignoredlc-on {
            left: 6px;
            opacity: 0;
        }

        /* --- Toggle Logic --- */
        .ignoredlc-toggle-switch input:not(:checked) + .ignoredlc-toggle-slider .ignoredlc-off {
            opacity: 1;
        }
        .ignoredlc-toggle-switch input:not(:checked) + .ignoredlc-toggle-slider .ignoredlc-on {
            opacity: 0;
        }
        .ignoredlc-toggle-switch input:checked + .ignoredlc-toggle-slider .ignoredlc-off {
            opacity: 0;
        }
        .ignoredlc-toggle-switch input:checked + .ignoredlc-toggle-slider .ignoredlc-on {
            opacity: 1;
        }

        .excludemissing-toggle-wrapper {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 13px;
            color: #c7d5e0;
            white-space: nowrap;
        }

        .excludemissing-toggle-label  {
            font-weight:bold;
            font-size:13px;
            color:#c7d5e0;
        }

        .excludemissing-toggle-switch {
            position: relative;
            display: inline-block;
            /* Reduced size */
            width: 44px;
            height: 18px;
        }

        .excludemissing-toggle-slider {
            position: absolute;
            inset: 0;
            background: #555;
            border-radius: 999px;
            cursor: pointer;
            transition: background 0.3s;
        }

        .excludemissing-toggle-slider::before {
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

        .excludemissing-toggle-switch input:checked + .excludemissing-toggle-slider::before {
            /* (Width - Knob Width - Margins) = (44 - 14 - 4) = 26px */
            transform: translateX(26px);
        }

        .excludemissing-toggle-switch input:checked + .excludemissing-toggle-slider {
            background: #66c0f4;
        }

        .excludemissing-toggle-text {
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

        .excludemissing-toggle-switch input:not(:checked) + .excludemissing-toggle-slider .excludemissing-off {
            opacity: 0; /* Using opacity: 0 for a cleaner look on small sizes */
        }

        .excludemissing-toggle-switch input:checked + .excludemissing-toggle-slider .excludemissing-on {
            opacity: 0;
        }

        .excludemissing-off {
            right: 6px;
            opacity: 1;
        }
        .excludemissing-on {
            left: 6px;
            opacity: 0;
        }

        /* --- Toggle Logic --- */
        .excludemissing-toggle-switch input:not(:checked) + .excludemissing-toggle-slider .excludemissing-off {
            opacity: 1;
        }
        .excludemissing-toggle-switch input:not(:checked) + .excludemissing-toggle-slider .excludemissing-on {
            opacity: 0;
        }
        .excludemissing-toggle-switch input:checked + .excludemissing-toggle-slider .excludemissing-off {
            opacity: 0;
        }
        .excludemissing-toggle-switch input:checked + .excludemissing-toggle-slider .excludemissing-on {
            opacity: 1;
        }

        .sg-pill-group {
            display: flex;
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid #3b5871;
            background: #1b2838;
        }

        .sg-pill {
            flex: 1;
            padding: 6px 14px;
            font-size: 13px;
            color: #c7d5e0;
            background: transparent;
            border: none;
            cursor: pointer;
            white-space: nowrap;
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
            min-width: 40px;
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
            display: grid;
            grid-template-columns: auto 1fr;
            column-gap: 24px;
            row-gap: 12px;
            align-items: start;
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

        .sg-review-field {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .sg-review-filter {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .sg-review-filter input[type="number"] {
            width: 90px;
            background: #3a3a3a;
            border: 1px solid #555;
            color: #ddd;
            border-radius: 4px;
            padding: 0 8px;
        }

        .sg-review-filter input:disabled {
            opacity: 0.5;
        }

        .sg-review-filter input[type="number"]::-webkit-outer-spin-button,
        .sg-review-filter input[type="number"]::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        .sg-review-filter input[type="number"] {
            -moz-appearance: textfield;
            appearance: textfield;
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

       #sg-user-table thead th {
           position: sticky;
           top: 0;
           z-index: 2;
           background: #2a475e;
       }
       #sg-flat-table thead th {
           position: sticky;
           top: 0;
           z-index: 2;
           background: #2a475e;
       }
       .sg-back-to-top {
           display: none;
           position: sticky;
           left: 50%;
           transform: translateX(-50%);
           bottom: 0px;
           width: 28px;
           height: 28px;
           background: rgba(42, 71, 94, 0.4);
           color: rgba(255, 255, 255, 0.7);
           border: 1px solid rgba(102, 192, 244, 0.3);
           border-radius: 4px;
           cursor: pointer;
           z-index: 99;
           font-size: 14px;
           line-height: 26px;
           text-align: center;
           transition: all 0.2s ease-in-out;
       }

       .sg-back-to-top:hover {
           background: rgba(102, 192, 244, 0.8); /* Becomes visible on hover */
           color: #fff;
           border-color: #66c0f4;
           transform: translateX(-50%) translateY(-2px); /* Slight lift effect */
       }
       .sg-options-left {
           display: flex;
           flex-direction: column;
           gap: 12px;
       }

       .sg-options-right {
           min-width: 170px; /* keeps panel narrow */
       }

       .sg-date-group {
           display: flex;
           flex-direction: column;
           gap: 8px;
           font-size: 12px;
           color: #c7d5e0;
       }

       .sg-date-label {
           font-weight: 600;
           opacity: 0.85;
       }

       .sg-date-field {
           display: flex;
           flex-direction: column;
           gap: 2px;
           font-size: 11px;
           opacity: 0.9;
       }

       .sg-date-field input[type="date"] {
           padding: 3px 6px;
           font-size: 12px;
           background: #1f364a;
           border: 1px solid #3b5871;
           color: #c7d5e0;
           border-radius: 3px;
       }
       #sgProfileStatsMode {
           margin-left: auto;
           background: #1b2838;
           color: #c7d5e0;
           border: 1px solid #3b5871;
           border-radius: 4px;
           padding: 2px 6px;
           width: auto;
       }
       #sg-summary-table {
            width: 100%;
            margin-top: 10px;
            border-collapse: separate;
            border-spacing: 0;
            table-layout: fixed;
            background: #1b2838;
            color: #d2d2d2;
        }
        /* Default cell behavior: center aligned with right/bottom borders */
        #sg-summary-table th, #sg-summary-table td {
            padding: 8px 4px;
            border-right: 1px solid #444;
            border-bottom: 1px solid #444;
            text-align: center;
            vertical-align: middle;
            white-space: nowrap;
        }
        /* First column (Usernames) should be left-aligned and have a left border */
        #sg-summary-table th:first-child,
        #sg-summary-table td:first-child {
            text-align: left;
            border-left: 1px solid #444;
            padding-left: 10px;
        }
        /* Sticky Average Row */
        .sticky-avg {
            position: sticky;
            top: 0;
            z-index: 10;
            background: #1b2838 !important;
            font-weight: bold;
            color: #66c0f4;
        }
        /* Add the top border only to the first sticky row */
        .sticky-avg td { border-top: 1px solid #444; }

        /* Sticky Header Row */
        .sticky-header th {
            position: sticky;
            background: #2a475e !important;
            color: #fff;
            z-index: 9;
            cursor: pointer;
        }
        /* Small text formatting */
        #sg-summary-table small { opacity: 0.7; font-size: 0.85em; }
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

                    <!-- LEFT OPTIONS -->
                    <div class="sg-options-left">
                        <div class="sg-pill-group" id="sgModePills">
                            <button class="sg-pill active" data-mode="single">Single user</button>
                            <button class="sg-pill" data-mode="all">All winners</button>
                            <button class="sg-pill" data-mode="group">Group members</button>
                        </div>

                        <div class="sg-options-container">
                            <label class="sg-checkbox-label">
                                <input type="checkbox" id="sgWhitelistOnly" title="Only include whitelise-only giveaways">
                                <span>Whitelist-only</span>
                            </label>

                            <label class="sg-checkbox-label">
                                <input type="checkbox" id="sgFullCvOnly" title="Only include Full CV giveaways">
                                <span>Full CV</span>
                            </label>

                            <div class="sg-review-filter">
                                <label class="sg-checkbox-label">
                                    <input type="checkbox" id="sgReviewFilterEnabled">
                                    <span>Filter by reviews</span>
                                </label>

                                <div class="sg-review-field">
                                    <input
                                        id="sgMinReviewScore"
                                        type="number"
                                        min="0"
                                        max="100"
                                        placeholder="score"
                                        title="Minimum review score (%)"
                                    >
                                    <span>%</span>
                                </div>

                                <input
                                    id="sgMinReviewCount"
                                    type="number"
                                    min="0"
                                    placeholder="num reviews"
                                    title="Minimum number of reviews"
                                >
                            </div>

                            <label class="sg-creator-field">
                                <span>Filter by creator</span>
                                <input id="sgCreatorFilter"
                                       placeholder="username"
                                       title="Filter giveaways by creator (group mode only)">
                            </label>
                        </div>
                    </div>

                    <!-- RIGHT OPTIONS -->
                    <div class="sg-options-right">
                        <div class="sg-date-group">
                            <div class="sg-date-label">Date range</div>

                            <label class="sg-date-field">
                                <span>From</span>
                                <input type="date" id="sgStartDate">
                            </label>

                            <label class="sg-date-field">
                                <span>To</span>
                                <input type="date" id="sgEndDate">
                            </label>
                        </div>
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
    <div class="annotate-toggle-wrapper" id="sgAnnotateToggleRow">

        <span class="annotate-toggle-label">
            User Profile Summary Format
            <span class="sg-info-icon" title="Format for summary displayed on user profile pages\n
[Off] Hidden\n[Compact] Percentages only\n[Full] Percentages + Values">i</span>
        </span>

        <select id="sgProfileStatsMode">
            <option value="off">Off</option>
            <option value="compact">Compact</option>
            <option value="full">Full</option>
        </select>

    </div>
    <div class="highlightwl-toggle-wrapper" id="sgHighlightWLToggleRow">
        <span class="highlightwl-toggle-label">Mark Whitelist-Only Giveaways</span>
        <label class="highlightwl-toggle-switch">
            <input type="checkbox" id="sgHighlightWLToggle">
            <span class="highlightwl-toggle-slider">
                <span class="highlightwl-toggle-text highlightwl-off">OFF</span>
                <span class="highlightwl-toggle-text highlightwl-on">ON</span>
            </span>
        </label>
    </div>
    <div class="playratestarted-toggle-wrapper" id="sgPlayrateStartedToggleRow">
        <span class="playratestarted-toggle-label">
            Show Started Games in Play Rate Chart
            <span class="sg-info-icon" title="Controls data displayed in play rate bar chart
\n[OFF] Played games only (>25% [blue])
[ON] Played games (>25% [blue]) AND started games (>0% [orange])">i</span>
        </span>
        <label class="playratestarted-toggle-switch">
            <input type="checkbox" id="sgPlayrateStartedToggle">
            <span class="playratestarted-toggle-slider">
                <span class="playratestarted-toggle-text playratestarted-off">OFF</span>
                <span class="playratestarted-toggle-text playratestarted-on">ON</span>
            </span>
        </label>
    </div>
    <div class="ignoredlc-toggle-wrapper" id="sgIgnoreDlcToggleRow">
        <span class="ignoredlc-toggle-label">Ignore DLCs</span>
        <label class="ignoredlc-toggle-switch">
            <input type="checkbox" id="sgIgnoreDlcToggle">
            <span class="ignoredlc-toggle-slider">
                <span class="ignoredlc-toggle-text ignoredlc-off">OFF</span>
                <span class="ignoredlc-toggle-text ignoredlc-on">ON</span>
            </span>
        </label>
    </div>
    <div class="excludemissing-toggle-wrapper" id="sgExcludeMissingToggleRow">
        <span class="excludemissing-toggle-label">
            Exclude Missing Games From Play Rate
            <span class="sg-info-icon" title="[OFF] (default) Missing games (privated, revoked, etc) count as unplayed for play rate calculations if they have achievements.
\n[ON] Missing games are excluded from play rate calculations.">i</span>
        </span>
        <label class="excludemissing-toggle-switch">
            <input type="checkbox" id="sgExcludeMissingToggle">
            <span class="excludemissing-toggle-slider">
                <span class="excludemissing-toggle-text excludemissing-off">OFF</span>
                <span class="excludemissing-toggle-text excludemissing-on">ON</span>
            </span>
        </label>
    </div>
    `;
    document.body.appendChild(panel);

    // restore panel position
    const savedTop = localStorage.getItem('playstats_panelTop');
    const savedLeft = localStorage.getItem('playstats_panelLeft');

    if (savedTop !== null && savedLeft !== null) {
        const top = parseInt(savedTop, 10);
        const left = parseInt(savedLeft, 10);

        const panelWidth  = panel.offsetWidth;
        const panelHeight = panel.offsetHeight;

        const maxLeft = window.innerWidth  - panelWidth;
        const maxTop  = window.innerHeight - panelHeight;

        const clampedLeft = Math.max(0, Math.min(left, maxLeft));
        const clampedTop  = Math.max(0, Math.min(top,  maxTop));

        panel.style.top  = clampedTop + 'px';
        panel.style.left = clampedLeft + 'px';
        panel.style.right = 'auto';
    }

    const pills = document.querySelectorAll('#sgModePills .sg-pill');
    const userInput = document.getElementById('sgUser');

    const creatorInput = document.getElementById('sgCreatorFilter');

    creatorInput.style.display = 'inline-block';

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
                pill.title = "Scan only winners who are group members";
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
        const match = location.pathname.match(/^\/user\/([^/]+)\/giveaways\/won/);
        if (!match) return;

        const usernameFromURL = match[1];

        // Only prefill if empty
        if (!input.value.trim()) {
            input.value = usernameFromURL;
        }
    })();

    // Hide whitelist-only checkbox on group pages
    const whitelistCheckbox = document.getElementById('sgWhitelistOnly');

    if (whitelistCheckbox) {
        if (isGroupPage) {
            const label = whitelistCheckbox.closest('.sg-checkbox-label');
            if (label) {
                label.style.display = 'none';
            }
        }
    }

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

    const annotateToggleRow = document.getElementById('sgAnnotateToggleRow');
    if (annotateToggleRow) {
        settingsPanel.appendChild(annotateToggleRow);
    }

    const highlightWLToggleRow = document.getElementById('sgHighlightWLToggleRow');
    if (highlightWLToggleRow) {
        settingsPanel.appendChild(highlightWLToggleRow);
    }

    const playrateStartedToggleRow = document.getElementById('sgPlayrateStartedToggleRow');
    if (playrateStartedToggleRow) {
        settingsPanel.appendChild(playrateStartedToggleRow);
    }

    const ignoreDlcToggleRow = document.getElementById('sgIgnoreDlcToggleRow');
    if (ignoreDlcToggleRow) {
        settingsPanel.appendChild(ignoreDlcToggleRow);
    }

    const excludeMissingToggleRow = document.getElementById('sgExcludeMissingToggleRow');
    if (excludeMissingToggleRow) {
        settingsPanel.appendChild(excludeMissingToggleRow);
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
            'Steam Cache Expiry (days)',
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
            'Maximum number of giveaways that can be stored in cache (Default = 50000). If exceeded, the least recently used cached page gets evicted.\n\nEach giveaway entry uses ~250-300 bytes, so 50,000 entries will occupy ~12MB.',
            '50000'
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            'Show Cache Disk Usage (Console)',
            'Show Playstats cache storage usage in console',
            () => debugShowCacheStorageFootprint()
        )
    );

    debugSection.content.appendChild(
        makeSettingsButton(
            'Show Giveaway Cache Contents (Console)',
            'Log giveaway cache contents to console',
            () => debugShowGiveawayCache()
        )
    );

    const separator2 = document.createElement('div');
    separator2.style = "height: 1px; background: #3b5871; margin: 10px 0; opacity: 0.5;";
    debugSection.content.appendChild(separator2)

    debugSection.content.appendChild(makeDebugSubHeader('Cache Management'));

    debugSection.content.appendChild(
        makeSettingsButton(
            'Clear Giveaway Cache for Current Page',
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
            'Clear ALL Giveaway Caches',
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
            'Clear Steam Cache',
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
            'Clear Subid Mapping Cache',
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
            'Clear SteamID Cache',
            'Clear the cache holding user steamid values.',
            () => {
                if (!confirm('Clear steamid cache?')) return;
                localStorage.getItem(`playstats_steamid_map`);
                status('Cleared steamid cache.');
            }
        )
    );

    const separator3 = document.createElement('div');
    separator3.style = "height: 1px; background: #3b5871; margin: 10px 0; opacity: 0.5;";
    debugSection.content.appendChild(separator3)

    const debugCacheBtn = document.createElement('button');
    debugCacheBtn.textContent = '🧪 View Cached DLCs (Console)';
    debugCacheBtn.className = 'sg-secondary-btn';

    debugCacheBtn.onclick = () => {
        const cache = GM_getValue(ESGST_CACHE_KEY, null);
        if (!cache) {
            alert('No ESGST cache found');
            return;
        }

        console.table(
            Object.entries(cache.apps)
                .filter(([, v]) => v.isDlc)
        );
    };

    debugSection.content.appendChild(debugCacheBtn);

    sgSettingsBtn.onclick = () => {
        const open = settingsPanel.style.display === 'block';
        settingsPanel.style.display = open ? 'none' : 'block';
    };

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

    const profileModeSelect =
        document.getElementById('sgProfileStatsMode');

    profileModeSelect.value = profileStatsMode;

    profileModeSelect.addEventListener('change', async () => {

        profileStatsMode = profileModeSelect.value;

        localStorage.setItem(
            PROFILE_STATS_MODE_KEY,
            profileStatsMode
        );

        refreshAnnotations();
    });

    const highlightWLToggle = document.getElementById('sgHighlightWLToggle');

    // Load saved state from localStorage (default to true if not set)
    const savedHighlightWL = localStorage.getItem('playstats_highlightwl');
    highlightWLToggle.checked = savedHighlightWL !== null ? JSON.parse(savedHighlightWL) : highlightWLON;

    // Set the variable to match saved state
    highlightWLON = highlightWLToggle.checked;

    highlightWLToggle.addEventListener('change', async () => {
        highlightWLON = highlightWLToggle.checked;

        // Save to localStorage
        localStorage.setItem('playstats_highlightwl', JSON.stringify(highlightWLON));
    });

    const playrateStartedToggle = document.getElementById('sgPlayrateStartedToggle');

    // Load saved state from localStorage (default to true if not set)
    const savedPlayrateStarted = localStorage.getItem('playstats_playratestarted');
    playrateStartedToggle.checked = savedPlayrateStarted !== null ? JSON.parse(savedPlayrateStarted) : playrateStartedON;

    // Set the variable to match saved state
    playrateStartedON = playrateStartedToggle.checked;

    playrateStartedToggle.addEventListener('change', async () => {
        playrateStartedON = playrateStartedToggle.checked;

        // Save to localStorage
        localStorage.setItem('playstats_playratestarted', JSON.stringify(playrateStartedON));
    });

    const ignoreDlcToggle = document.getElementById('sgIgnoreDlcToggle');

    // Load saved state from localStorage (default to true if not set)
    const savedIgnoreDlc = localStorage.getItem('playstats_ignoreDlc');
    ignoreDlcToggle.checked = savedIgnoreDlc !== null ? JSON.parse(savedIgnoreDlc) : ignoreDlcON;

    // Set the variable to match saved state
    ignoreDlcON = ignoreDlcToggle.checked;

    ignoreDlcToggle.addEventListener('change', async () => {
        ignoreDlcON = ignoreDlcToggle.checked;

        // Save to localStorage
        localStorage.setItem('playstats_ignoreDlc', JSON.stringify(ignoreDlcON));
        refreshAnnotations();
    });

    const excludeMissingToggle = document.getElementById('sgExcludeMissingToggle');

    // Load saved state from localStorage (default to true if not set)
    const savedexcludeMissing = localStorage.getItem('playstats_excludeMissing');
    excludeMissingToggle.checked = savedexcludeMissing !== null ? JSON.parse(savedexcludeMissing) : excludeMissingON;

    // Set the variable to match saved state
    excludeMissingON = excludeMissingToggle.checked;

    excludeMissingToggle.addEventListener('change', async () => {
        excludeMissingON = excludeMissingToggle.checked;

        // Save to localStorage
        localStorage.setItem('playstats_excludeMissing', JSON.stringify(excludeMissingON));
        refreshAnnotations();
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
            requestAnimationFrame(() => {
                const rect = panel.getBoundingClientRect();

                let left = rect.left;
                let top  = rect.top;

                if (rect.right > window.innerWidth) {
                    left = window.innerWidth - rect.width;
                }

                if (rect.bottom > window.innerHeight) {
                    top = window.innerHeight - rect.height;
                }

                panel.style.left = Math.max(0, left) + 'px';
                panel.style.top  = Math.max(0, top)  + 'px';
            });
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

        const newLeft = e.clientX - dragOffsetX;
        const newTop  = e.clientY - dragOffsetY;

        const rect = panel.getBoundingClientRect();
        const panelWidth  = rect.width;
        const panelHeight = rect.height;

        const maxLeft = window.innerWidth  - panelWidth;
        const maxTop  = window.innerHeight - panelHeight;

        // Clamp
        const clampedLeft = Math.max(0, Math.min(newLeft, maxLeft));
        const clampedTop  = Math.max(0, Math.min(newTop,  maxTop));

        panel.style.left = clampedLeft + 'px';
        panel.style.top  = clampedTop  + 'px';
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

    function getTotalJsonPages() {
        try {
            // 1. On "Won" pages, calculate total from "Gifts Won" + "Not Received"
            if (isUserWonPage) {
                const rows = document.querySelectorAll('.featured__table__row');
                for (const row of rows) {
                    const label = row.querySelector('.featured__table__row__left')?.textContent?.trim();
                    if (label === 'Gifts Won') {
                        const rightCol = row.querySelector('.featured__table__row__right');
                        if (!rightCol) break;

                        // Grab number directly from the main link in the right column
                        const wonLink = rightCol.querySelector('a');
                        const wonCount = parseInt(wonLink?.textContent.replace(/,/g, ''), 10) || 0;

                        // Extract "Not Received" count from tooltip if present
                        let notReceivedCount = 0;
                        const tooltipContainer = rightCol.querySelector('[data-ui-tooltip]');
                        if (tooltipContainer) {
                            const tooltipDataStr = tooltipContainer.getAttribute('data-ui-tooltip') || '';
                            const nrMatch = tooltipDataStr.match(/"Not Received"\}?,\s*\{"name"\s*:\s*"(\d+)"/);
                            if (nrMatch) {
                                notReceivedCount = parseInt(nrMatch[1], 10) || 0;
                            }
                        }

                        const totalCount = wonCount + notReceivedCount;
                        if (totalCount > 0) return Math.ceil(totalCount / 100);
                    }
                }
            }

            // 2. For all other pages (Groups, User Sent/Profile, etc.), use the Sidebar count
            const sidebarCountEl = document.querySelector('.sidebar__navigation__item__count');
            if (sidebarCountEl) {
                const count = parseInt(sidebarCountEl.textContent.replace(/,/g, ''), 10);
                if (!isNaN(count) && count > 0) return Math.ceil(count / 100);
            }
        } catch (err) {
            console.warn('Could not pre-calculate total JSON pages:', err);
        }

        return null;
    }

    function isWhitelistOnlyGiveaway(g) {
        const hasWhitelist = !!g.querySelector('.giveaway__column--whitelist');
        const hasGroup = !!g.querySelector('.giveaway__column--group');
        return hasWhitelist && !hasGroup;
    }

    function chunkArray(arr, size) {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
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

    // ****** IGNORE DLC HELPERS ******* //
    async function queryEsgstGames(appIds, subIds) {
        const merged = {
            found: { apps: {}, subs: {} }
        };

        const appChunks = chunkArray(appIds, ESGST_BATCH_SIZE);
        const subChunks = chunkArray(subIds, ESGST_BATCH_SIZE);
        const maxChunks = Math.max(appChunks.length, subChunks.length);

        for (let i = 0; i < maxChunks; i++) {
            const apps = appChunks[i] ?? [];
            const subs = subChunks[i] ?? [];

            if (!apps.length && !subs.length) continue;

            const params = new URLSearchParams();
            if (apps.length) params.set('app_ids', apps.join(','));
            if (subs.length) params.set('sub_ids', subs.join(','));

            const res = await fetch(
                `https://esgst.rafaelgomes.xyz/api/games?${params}`
            );

            if (!res.ok) {
                throw new Error(`ESGST GetGames failed (${res.status})`);
            }

            const json = await res.json();
            const found = json?.result?.found;

            if (found?.apps) Object.assign(merged.found.apps, found.apps);
            if (found?.subs) Object.assign(merged.found.subs, found.subs);
        }

        return merged;
    }

    function getMissingDlcIds(wins, cache) {
        const apps = new Set();
        const subs = new Set();

        for (const g of wins) {
            if (g.app && cache?.apps?.[g.app]?.isDlc === undefined) {
                apps.add(g.app);
            }
            if (g.sub && cache?.subs?.[g.sub]?.isDlc === undefined) {
                subs.add(g.sub);
            }
        }

        return {
            app_ids: [...apps],
            sub_ids: [...subs]
        };
    }

    function mergeDlcIntoCache(cache, games) {
        for (const [id, data] of Object.entries(games.found.apps || {})) {
            cache.apps[id] ??= {};
            cache.apps[id].isDlc = data.base !== null;
            cache.apps[id].baseApp = data.base;
        }

        for (const [id, data] of Object.entries(games.found.subs || {})) {
            cache.subs[id] ??= {};
            cache.subs[id].isDlc = data.base !== null;
            cache.subs[id].baseApp = data.base;
        }
    }

    async function ensureEsgstDlcData(wins) {
        let cache = await loadEsgstCvCache();
        if (!cache) {
            cache = {
                fetchedAt: 0,
                apps: {},
                subs: {}
            };
        }

        const { app_ids, sub_ids } = getMissingDlcIds(wins, cache);

        if (!app_ids.length && !sub_ids.length) {
            return;
        }

        const games = await queryEsgstGames(app_ids, sub_ids);

        // Mark requested IDs as checked even if ESGST returns nothing
        for (const id of app_ids) {
            cache.apps[id] ??= {};
            cache.apps[id].isDlc ??= false;
            cache.apps[id].baseApp ??= null;
        }
        for (const id of sub_ids) {
            cache.subs[id] ??= {};
            cache.subs[id].isDlc ??= false;
            cache.subs[id].baseApp ??= null;
        }

        mergeDlcIntoCache(cache, games);

        cache.fetchedAt = Math.floor(Date.now() / 1000);
        GM_setValue(ESGST_CACHE_KEY, cache);
    }

    function filterOutDlcWins(wins) {
        const cache = GM_getValue(ESGST_CACHE_KEY, null);
        if (!cache) return wins; // fail open

        return wins.filter(win => {
            if (win.sub) return true;

            if (!win.app) return true; // safety
            const entry = cache.apps?.[win.app];
            if (!entry) return true; // unknown → keep

            if (entry.isDlc) {
                console.info(`[Playstats] Ignoring DLC win: ${win.name}`);
            return false;
            }
        return true;
        });
    }

    // ****** FULL CV HELPERS ******* //
    async function queryEsgstCv(endpoint, appIds, subIds) {
        const merged = {
            found: { apps: {}, subs: {} }
        };

        const appChunks = chunkArray(appIds, ESGST_BATCH_SIZE);
        const subChunks = chunkArray(subIds, ESGST_BATCH_SIZE);
        const maxChunks = Math.max(appChunks.length, subChunks.length);

        for (let i = 0; i < maxChunks; i++) {
            const apps = appChunks[i] ?? [];
            const subs = subChunks[i] ?? [];

            if (!apps.length && !subs.length) continue;

            const params = new URLSearchParams();
            if (apps.length) params.set('app_ids', apps.join(','));
            if (subs.length) params.set('sub_ids', subs.join(','));

            const res = await fetch(
                `https://esgst.rafaelgomes.xyz/api/games/${endpoint}?${params}`
            );

            if (!res.ok) {
                throw new Error(`ESGST ${endpoint} batch failed (${res.status})`);
            }

            const json = await res.json();
            const found = json?.result?.found;

            if (found?.apps) Object.assign(merged.found.apps, found.apps);
            if (found?.subs) Object.assign(merged.found.subs, found.subs);
        }

        return merged;
    }

    function getFullCVWins(wins) {
        const cache = GM_getValue(ESGST_CACHE_KEY, null);
        if (!cache) return wins;

        return wins.filter(win => {
            const ts = win.createdTs;
            if (!ts) return true; // fail open

            const entry = win.app
                ? cache.apps?.[win.app]
                : win.sub
                ? cache.subs?.[win.sub]
                : null;

            if (!entry) return true;

            const isNcv =
                entry.ncv &&
                Date.parse(entry.ncv.effective_date) / 1000 <= ts;

            const isRcv =
                entry.rcv &&
                Date.parse(entry.rcv.effective_date) / 1000 <= ts;

            return !isNcv && !isRcv;
        });
    }

    function loadEsgstCvCache() {
        const cache = GM_getValue(ESGST_CACHE_KEY, null);
        if (!cache) return null;

        if (!cache.fetchedAt) return cache;

        const now = Math.floor(Date.now() / 1000);
        if (now - cache.fetchedAt > ESGST_CACHE_TTL) {
            return null;
        }

        return cache;
    }

    function getMissingCvIds(wins, cache) {
        const apps = new Set();
        const subs = new Set();

        for (const g of wins) {
            if (
                g.app &&
                (
                    !cache?.apps?.[g.app] ||
                    (!cache.apps[g.app].ncv && !cache.apps[g.app].rcv)
                )
            ) {
                apps.add(g.app);
            }
            if (
                g.sub &&
                (
                    !cache?.subs?.[g.sub] ||
                    (!cache.subs[g.sub].ncv && !cache.subs[g.sub].rcv)
                )
            ) {
                subs.add(g.sub);
            }
        }

        return {
            app_ids: [...apps],
            sub_ids: [...subs]
        };
    }

    function getMinReviewWins(wins, minReviews, minScore) {
        const cache = loadSteamMetaCache();

        if (!cache?.apps) return [];

        return wins.filter(g => {
            const meta = cache.apps[g.app];
            if (!meta) return false;

            return (
                meta.reviews >= minReviews &&
                meta.reviewScore >= minScore
            );
        });
    }

    function fetchReviewData(appid) {
        return new Promise((resolve, reject) => {

            const url =
                `https://store.steampowered.com/appreviews/${appid}` +
                `?json=1&num_per_page=0&language=all&purchase_type=all`;

            GM_xmlhttpRequest({
                method: 'GET',
                url,

                onload: response => {
                    try {
                        const data = JSON.parse(response.responseText);

                        resolve({
                            total_positive:
                                data?.query_summary?.total_positive ?? 0,

                            total_reviews:
                                data?.query_summary?.total_reviews ?? 0
                        });

                    } catch (err) {
                        reject(err);
                    }
                },

                onerror: reject
            });
        });
    }

    async function fetchSteamMeta(appid) {
        const reviewData = await fetchReviewData(appid);

        const reviewPct =
            reviewData.total_reviews > 0
            ? (reviewData.total_positive * 100 /
               reviewData.total_reviews)
            : 0;

        return {
            reviews: reviewData.total_reviews,
            reviewScore: reviewPct
        };
    }

    function loadSteamMetaCache() {
        const cache = GM_getValue(STEAM_META_CACHE_KEY, null);
        if (!cache) return null;

        if (!cache.fetchedAt) return cache;

        const now = Math.floor(Date.now() / 1000);
        if (now - cache.fetchedAt > STEAM_META_CACHE_TTL) {
            return null;
        }

        return cache;
    }

    function getMissingSteamMetaIds(wins, cache) {
        const apps = new Set();

        for (const g of wins) {
            if (!g.app) continue;

            if (!cache.apps?.[g.app]) {
                apps.add(g.app);
            }
        }

        return [...apps];
    }

    function mergeIntoCache(cache, ncv, rcv) {
        for (const [id, data] of Object.entries(ncv.found.apps || {})) {
            cache.apps[id] ??= {};
            cache.apps[id].ncv = data;
        }
        for (const [id, data] of Object.entries(rcv.found.apps || {})) {
            cache.apps[id] ??= {};
            cache.apps[id].rcv = data;
        }

        for (const [id, data] of Object.entries(ncv.found.subs || {})) {
            cache.subs[id] ??= {};
            cache.subs[id].ncv = data;
        }
        for (const [id, data] of Object.entries(rcv.found.subs || {})) {
            cache.subs[id] ??= {};
            cache.subs[id].rcv = data;
        }
    }

    async function ensureSteamMetaData(wins, updateStatus = () => {}) {

        let cache = loadSteamMetaCache();

        if (!cache) {
            cache = {
                fetchedAt: 0,
                apps: {}
            };
        }

        const missing = getMissingSteamMetaIds(wins, cache);

        const BATCH_SIZE = 10;

        let completed = 0;

        for (let i = 0; i < missing.length; i += STEAM_META_BATCH_SIZE) {

            const batch = missing.slice(i, i + STEAM_META_BATCH_SIZE);

            updateStatus(
                `Fetching Steam review data (${completed}/${missing.length})...`
            );

            const results = await Promise.all(
                batch.map(async appid => ({
                    appid,
                    meta: await fetchSteamMeta(appid)
                }))
            );

            for (const result of results) {
                cache.apps[result.appid] = result.meta;
                completed++;
            }

            await sleep(100);
        }

        cache.fetchedAt = Math.floor(Date.now() / 1000);

        GM_setValue(STEAM_META_CACHE_KEY, cache);
    }

    async function ensureEsgstCvData(wins) {
        const now = Math.floor(Date.now() / 1000);

        let cache = await loadEsgstCvCache();
        if (!cache) {
            cache = {
                fetchedAt: 0,
                apps: {},
                subs: {}
            };
        }

        const { app_ids, sub_ids } = getMissingCvIds(wins, cache);

        if (!app_ids.length && !sub_ids.length) {
            return; // cache hit, nothing to fetch
        }

        const fetchEsgstNcv = (apps, subs) =>
        queryEsgstCv('ncv', apps, subs);

        const fetchEsgstRcv = (apps, subs) =>
        queryEsgstCv('rcv', apps, subs);

        const [ncv, rcv] = await Promise.all([
            fetchEsgstNcv(app_ids, sub_ids),
            fetchEsgstRcv(app_ids, sub_ids)
        ]);

        // Mark all requested apps/subs as checked (even if ESGST returns nothing)
        for (const id of app_ids) {
            cache.apps[id] ??= {};
        }
        for (const id of sub_ids) {
            cache.subs[id] ??= {};
        }

        mergeIntoCache(cache, ncv, rcv);

        cache.fetchedAt = now;
        GM_setValue(ESGST_CACHE_KEY, cache);
    }

    async function saveUserStatsToCache(username, stats) {
        const key = `user_stats_${username.toLowerCase()}`;
        const data = {
            stats: stats,
            ts: Date.now()
        };
        // No need to stringify!
        await GM_setValue(key, data);
    }

    async function getUserStatsFromCache(username) {
        const key = `user_stats_${username.toLowerCase()}`;
        // No need to parse!
        return await GM_getValue(key, null);
    }

    // ****** RENDER HELPERS ******* //
    function computeUserStats(wins) {
        let eligible = 0;
        let gamesAnyCompletion = 0;
        let games25Completion = 0;
        let games100Completion = 0;

        let totalUnlocked = 0;
        let totalAvailable = 0;
        let sumCompletionPct = 0; // Cumulative sum of individual game percentages

        let totalHours = 0;
        let anyHours = 0;

        // Yearly data storage: { "2024": { total: 0, qualified: 0 }, ... }
        const yearlyData = {};

        for (const w of wins) {
            // 1. Process Playtime
            totalHours += w.hours ?? 0;
            if (w.hours) anyHours++;

            // 2. Process Achievements
            if (!w.ach || !w.ach.includes('/')) continue;

            const [done, total] = w.ach.split('/').map(Number);
            if (!total || isNaN(done) || isNaN(total)) continue;

            if (w.isMissing && excludeMissingON) continue;
            eligible++;

            // 3. Process Yearly Trend (Based on win date)
            const winYear = new Date(w.ts * 1000).getFullYear();
            if (!yearlyData[winYear]) yearlyData[winYear] = { total: 0, qualified: 0, any_completion: 0};
            yearlyData[winYear].total++;

            const pct = (done / total) * 100;

            if (pct > 0) {
                gamesAnyCompletion++;
                yearlyData[winYear].any_completion++; // Track for the chart
                sumCompletionPct += pct; // Add individual game % to the running total
            }
            if (pct >= 25) {
                games25Completion++;
                yearlyData[winYear].qualified++; // Track for the chart
            }
            if (pct === 100) games100Completion++;

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
            games100Completion,
            pctAnyCompletion: eligible ? (Math.round((gamesAnyCompletion / eligible) * 1000) / 10) : 0,
            pct25Completion: eligible ? (Math.round((games25Completion / eligible) * 1000) / 10) : 0,
            pct100Completion: eligible ? (Math.round((games100Completion / eligible) * 1000) / 10) : 0,
            // Average of individual percentages (Steam style)
            compPct: gamesAnyCompletion ? (Math.round((sumCompletionPct / gamesAnyCompletion) * 10) / 10) : 0,
            totalHours: totalHours / 60,
            anyHours: anyHours,
            pctAnyHours: (Math.round((anyHours / wins.length) * 1000) / 10),
            avgHours: anyHours ? Math.round((totalHours / 60) / anyHours * 10) / 10 : 0,
            totalUnlocked,
            totalAvailable,
            yearlyData // Added for chart rendering
        };
    }

    function renderYearlyHistogram(yearlyData) {
        const years = Object.keys(yearlyData).sort();
        if (years.length === 0) return '';

        const maxWins = Math.max(...years.map(y => yearlyData[y].total));

        let chartHtml = `
            <div style="display: flex; align-items: flex-end; height: 120px; gap: 4px; padding-top: 20px; border-bottom: 1px solid #3d4450; font-family: Arial, sans-serif;">`;

        years.forEach(year => {
            const d = yearlyData[year];
            const totalHeight = (d.total / maxWins) * 100;
            const qualifiedHeight = (d.qualified / d.total) * 100;

            chartHtml += `
                <div style="flex: 1; display: flex; flex-direction: column; align-items: center; position: relative;" title="${year}: ${d.qualified}/${d.total} (≥25%)">
                    <div style="width: 100%; height: ${totalHeight}px; background: #3d4450; position: relative; display: flex; flex-direction: column-reverse;">
                        <div style="width: 100%; height: ${qualifiedHeight}%; background: #66c0f4;"></div>
                    </div>
                    <span style="font-size: 10px; margin-top: 5px; transform: rotate(-45deg); white-space: nowrap; opacity: 0.8;">${year}</span>
                </div>`;
        });

        chartHtml += `</div>`;
        return chartHtml;
    }

    async function exportTableToCSV(table, suggestedName) {
        const rows = Array.from(table.querySelectorAll('tr'));
        const csv = rows.map(row => {
            const cells = Array.from(row.querySelectorAll('th, td'));
            return cells.map(cell => {
                let text = cell.innerText
                    .replace(/\s+/g, ' ')
                    .trim()
                    .replace(/🔒/g, '')
                    .replace(/💙/g, '')
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

    function getFlatResults() {
        return Object.entries(scanState.userMap).flatMap(([user, wins]) => {
            return wins.map(win => ({
                ...win,
                winner: user // Store the key for lookups
            }));
        });
    }

    async function refreshAnnotations() {

        document
            .querySelectorAll('.sg-injected-row')
            .forEach(el => el.remove());

        if (profileStatsMode !== 'off') {
            await injectStatsToSgTable();
        }
    }

    const verboseStats =
    localStorage.getItem('sgProfileStatsVerbose') === 'true';

    function statDisplay(pct, num, den, tooltipTitle) {

        const tooltip =
            `data-ui-tooltip='{"rows":[{"columns":[{"name":"${tooltipTitle}"},{"name":"${num} / ${den}","color":"#8f96a6"}]}]}'`;

        if (profileStatsMode === 'full') {
            return `
                <span style="color:#eee;cursor:help;" ${tooltip}>
                    ${pct}% (${num}/${den})
                </span>
            `;
        }

        return `
            <span style="color:#eee;cursor:help;" ${tooltip}>
                ${pct}%
            </span>
        `;
    }

    async function injectStatsToSgTable() {
        const columns = document.querySelectorAll('.featured__table__column');
        const targetTable = columns[0];
        if (!targetTable) return;
        const pathParts = window.location.pathname.split('/');
        const profileOwner = pathParts[2]?.toLowerCase();
        if (!profileOwner) return;

        const cached = await getUserStatsFromCache(profileOwner);
        if (!cached) return;

        const { stats, ts } = cached;

        const createSgRow = (left, right, extraStyle = '') => {
            const row = document.createElement('div');
            row.className = 'featured__table__row sg-injected-row'; // Added marker class
            if (extraStyle) row.style = extraStyle;
            row.innerHTML = `
                <div class="featured__table__row__left">${left}</div>
                <div class="featured__table__row__right">${right}</div>
            `;
            return row;
        };

        // Helper to format the timestamp
        const lastUpdatedStr = new Date(ts).toLocaleString([], {
            dateStyle: 'medium',
            timeStyle: 'short'
        });

        // Achievement Row
        const achHtml = `
            <small style="opacity:0.6;">Any%</small>
            ${statDisplay(
                stats.pctAnyCompletion,
                stats.gamesAnyCompletion,
                stats.eligible,
                '>0 🏆'
            )}

            <span style="margin:0 5px;opacity:0.3;">|</span>

            <small style="opacity:0.6;">>25%</small>
            ${statDisplay(
                stats.pct25Completion,
                stats.games25Completion,
                stats.eligible,
                '>25% 🏆'
            )}

            <span style="margin:0 5px;opacity:0.3;">|</span>

            <small style="opacity:0.6;">100%</small>
            ${statDisplay(
                stats.pct100Completion,
                stats.games100Completion,
                stats.eligible,
                '100% 🏆'
            )}

            <span style="margin:0 5px;opacity:0.3;">|</span>

            <small style="opacity:0.6;">Avg Completion</small>
            <span style="color:#eee;">${stats.compPct}%</span>
        `;

        // Playtime Row
        const playHtml = `
            <small style="opacity:0.6;">>0 Hours</small>
            ${statDisplay(
                stats.pctAnyHours,
                stats.anyHours,
                stats.gamesWon,
                '>0 Hours'
            )}

            <span style="margin:0 5px;opacity:0.3;">|</span>

            <small style="opacity:0.6;">Avg Playtime</small>
            <span style="color:#eee;">${stats.avgHours}h</span>
        `;

        // 1. Add Achievements
        targetTable.appendChild(createSgRow('Achievements', achHtml));
        // 2. Add Playtime
        targetTable.appendChild(createSgRow('Playtime', playHtml));
        // 3. Add Last Updated (using smaller font and subtle color)
        targetTable.appendChild(createSgRow(
            '<span style="opacity: 0.5; font-size: 11px;"></span>',
            `<span style="opacity: 0.5; font-style: italic; font-size: 11px;">Last Checked ${lastUpdatedStr}</span>`
        ));

        // Re-initialize SG Tooltips so the new data attributes work
        if (typeof(main) !== 'undefined' && main.initTooltips) {
            main.initTooltips();
        }
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

    async function fetchFullWinnerList(giveawayUrl) {
        if (!giveawayUrl) return null;
        const winnersUrl = giveawayUrl.endsWith('/') ? `${giveawayUrl}winners` : `${giveawayUrl}/winners`;
        let allWinners = [];
        let page = 1;
        let lastPage = 1;

        try {
            do {
                const doc = await fetchDoc(`${winnersUrl}?page=${page}`);
                if (!doc) break;

                const rows = doc.querySelectorAll('.table__row-inner-wrap');

                rows.forEach(row => {
                    const statusCol = row.querySelector('.table__column--width-small.text-center');
                    const isReceived = statusCol && statusCol.querySelector('.fa-check-circle');

                    if (isReceived) {
                        // 1. Find the heading paragraph
                        const headingCol = row.querySelector('.table__column__heading');
                        // 2. Find the link inside it that has the user data
                        const winnerLink = headingCol?.querySelector('a[data-href^="/user/"], a[href^="/user/"]');
                        if (winnerLink) {
                            const name = winnerLink.textContent.trim();
                            if (name) {
                                scanState.userDisplay[name.toLowerCase()] ??= name;
                                allWinners.push(name.toLowerCase());
                            }
                        }
                    }
                });

                const pagLinks = doc.querySelectorAll('.pagination__navigation a[data-page-number]');
                lastPage = pagLinks.length ? Math.max(...Array.from(pagLinks).map(a => parseInt(a.dataset.pageNumber))) : 1;

                if (page < lastPage) {
                    page++;
                    await sleep(800);
                } else {
                    break;
                }
            } while (page <= lastPage);

            return allWinners.length ? allWinners : null;
        } catch (e) {
            console.error(`Error fetching winners:`, e);
            return null;
        }
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

        const newlyScanned = [];
        let stopScanning = false;
        let page = 1;
        let totalPages = getTotalJsonPages(); // Pre-calculated from DOM

        while (!stopScanning) {
            const pageStatus = totalPages
                    ? `Scanning page ${page} / ${totalPages}…`
                    : `Scanning page ${page}…`;
            status(pageStatus);

            let json;
            try {
                // Include &include_winners=1 to fetch all winners directly in the payload
                const res = await fetch(`${base}?format=json&include_winners=1&page=${page}`);
                if (!res.ok) throw new Error(`HTTP error ${res.status}`);
                json = await res.json();
            } catch (err) {
                console.error(`Failed to fetch JSON page ${page}:`, err);
                break;
            }

            const results = json?.results || [];

            // Stop if API returns unsuccessful or an empty array
            if (!json?.success || !results.length) {
                break;
            }

            for (const g of results) {
                const endTs = g.end_timestamp || null;
                const createdTs = g.created_timestamp || null;

                // Extract winners directly from the payload
                let winners = [];

                if (forcedWinner) {
                    // On user won page, verify the gift wasn't marked as "Not Received"
                    if (Array.isArray(g.winners)) {
                        const isReceived = g.winners.some(w => w?.received === true);
                        if (isReceived) {
                            winners = [forcedWinner];
                        }
                    }
                } else if (Array.isArray(g.winners)) {
                    winners = g.winners
                        // Only include confirmed winners who have provided feedback (received === true)
                        // and have a valid username string
                        .filter(w => w?.received === true && typeof w.username === 'string' && w.username.trim() !== '')
                        .map(w => {
                            const uname = w.username.trim().toLowerCase();
                            // Save display name casing lookup
                            scanState.userDisplay[uname] ??= w.username.trim();
                            return uname;
                        });
                }

                // Skip entries with no timestamp or unresolved/empty winners
                if (!endTs || !winners.length) continue;

                // 14-day safety window cache check
                if (endTs < now - GA_SAFETY_WINDOW_DAYS * 24 * 60 * 60) {
                    if (endTs <= lastCacheUpdate) {
                        stopScanning = true;
                        break;
                    }
                }

                const name = g.name;
                const url = g.link;
                const app = g.app_id ? Number(g.app_id) : null;
                const sub = g.package_id ? Number(g.package_id) : null;
                const hasWhitelist = !!g.whitelist;
                const wlonly = hasWhitelist && !g.group;
                const creator = g.creator?.username ? g.creator.username.toLowerCase() : null;

                const gid = getGiveawayId({ url, name, ts: endTs });

                newlyScanned.push({
                    gid, name, url, app, sub, isSub: !!sub,
                    ts: endTs, createdTs, wlonly, hasWhitelist, creator, winners
                });
            }

            // Break if we received fewer items than per_page (last page reached)
            const perPage = json.per_page || 100;
            if (results.length < perPage) {
                break;
            }

            page++;
            await sleep(SCAN_DELAY);
        }

        /* =========================================================================
           MERGE & CACHE UPDATE
           ========================================================================= */
        const existingCacheMap = new Map(cachedGiveaways.map(c => [c.gid, c]));

        const mergedScanned = newlyScanned.map(newG => {
            const cachedG = existingCacheMap.get(newG.gid);
            if (!cachedG) return newG;

            return {
                ...cachedG, // Preserve enriched flags like groupExclusive
                ...newG     // Overwrite with fresh winner data & timestamps
            };
        });

        const newIds = new Set(newlyScanned.map(g => g.gid));
        const merged = [
            ...mergedScanned,
            ...cachedGiveaways.filter(c => !newIds.has(c.gid))
        ];

        await saveGiveawayCache({
            lastCacheUpdate: now,
            giveaways: merged
        });

        return merged;
    }

    function showUserDetail(username, fullScan = false) {
        // Dynamic cleanup of header buttons
        ['table', '#dismiss-table', '#write-csv', '#flat-view', '#winners-view', '#back-to-summary', '#toggle-missing-filter'].forEach(sel => {
            resultsWrap.querySelector(sel)?.remove();
        });

        scanState.activeUser = username;
        scanState.viewMode = 'user';
        scanState.showMissingOnly = false; // Reset missing filter when switching users

        const wins = scanState.userMap[username];
        if (!wins) return;

        const stats = computeUserStats(wins);
        const hasAchData = stats.eligible > 0;

        const formatStatRow = (label, value, suffix = '', detail = '', forceNumeric = false) => {
            const displayValue = (forceNumeric || hasAchData) ? `${value}${suffix}` : 'N/A';

            return `
                <div style="line-height: 1.8; font-family: 'Segoe UI', sans-serif; display: flex; align-items: center; white-space: nowrap;">
                    <span style="width: 230px; opacity: 0.9;">${label}</span>
                    <span style="width: 60px; text-align: right; font-weight: bold; color: #fff;">${displayValue}</span>
                    <span style="margin-left: 12px; opacity: 0.5; font-size: 0.85em; min-width: 60px;">${detail}</span>
                </div>`;
        };

        const renderChart = (data) => {
            const years = Object.keys(data).sort();
            if (!years.length) return '<div style="opacity:0.5; text-align:center; padding-top:40px;">No trend data</div>';

            const maxYearWins = Math.max(...years.map(y => data[y].total));
            let barWidth = "70%";
            let labelSize = "10px";

            if (years.length > 8) {
                barWidth = "80%";
                labelSize = "9px";
            }

            let bars = years.map(year => {
                const d = data[year];
                const pct25 = d.total > 0 ? Math.round((d.qualified / d.total) * 100) : 0;
                const totalH = (d.total / maxYearWins) * 100;

                const anyH = playrateStartedON ? (d.any_completion / d.total) * 100 : 0;
                const qualH = playrateStartedON
                    ? (d.any_completion > 0 ? (d.qualified / d.any_completion) * 100 : 0)
                    : (d.total > 0 ? (d.qualified / d.total) * 100 : 0);

                return `
                    <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; position: relative;" title="${year}: Total: ${d.total}${playrateStartedON ? `, >0%: ${d.any_completion}` : ''}, ≥25%: ${d.qualified}">
                        <div style="display: flex; flex-direction: column; align-items: center; margin-bottom: 4px; line-height: 1;">
                            <span style="font-size: ${labelSize}; color: #66c0f4; font-weight: bold;">${pct25}%</span>
                        </div>

                        <div style="width: ${barWidth}; height: ${totalH}px; background: #3d4450; display: flex; flex-direction: column-reverse; border-radius: 2px 2px 0 0; overflow: hidden;">
                            <div style="width: 100%; height: ${playrateStartedON ? anyH : 100}%; ${playrateStartedON ? 'background: #f0ad4e;' : ''} display: flex; flex-direction: column-reverse;">
                                <div style="width: 100%; height: ${qualH}%; background: #66c0f4;"></div>
                            </div>
                        </div>

                        <span style="font-size: ${labelSize}; margin-top: 6px; color: #8f98a0; font-weight: bold;">'${year.toString().slice(-2)}</span>
                    </div>`;
            }).join('');

            return `
                <div style="display: flex; align-items: flex-end; height: 115px; gap: 4px; padding-bottom: 5px; border-bottom: 1px solid #3d4450;">
                    ${bars}
                </div>
                <div style="display: flex; justify-content: space-between; margin-top: 12px; font-size: 0.75em; opacity: 0.7; flex-wrap: wrap; gap: 8px;">
                    <span><i style="display:inline-block; width:8px; height:8px; background:#3d4450; margin-right:4px; border-radius:1px;"></i>Total Wins</span>
                    ${playrateStartedON ? `<span><i style="display:inline-block; width:8px; height:8px; background:#f0ad4e; margin-right:4px; border-radius:1px;"></i>Started (>0%)</span>` : ''}
                    <span><i style="display:inline-block; width:8px; height:8px; background:#66c0f4; margin-right:4px; border-radius:1px;"></i>Played (≥25%)</span>
                </div>`;
        };

        const statusEl = document.getElementById('sgStatus');
        if (statusEl) {
            statusEl.style.padding = "15px";
            statusEl.innerHTML = `
                <div style="display: flex; flex-direction: row; flex-wrap: nowrap; justify-content: space-between; align-items: stretch; gap: 20px; color: #d2d2d2;">
                    <div style="flex: 0 0 auto;">
                        <b style="font-size: 1.1em;">Detailed results for
                            <a href="https://www.steamgifts.com/user/${scanState.userDisplay[username] ?? username}" target="_blank" style="color:#66c0f4;">
                                ${scanState.userDisplay[username] ?? username}
                            </a>
                        </b>
                        <div style="margin-top: 10px; border-top: 1px solid #3d4450; padding-top: 10px;">
                            ${formatStatRow('🎮 >0% Achievement Completion', stats.pctAnyCompletion.toFixed(1), '%', `(${stats.gamesAnyCompletion}/${stats.eligible})`)}
                            ${formatStatRow('🏆 ≥25% Achievement Completion', stats.pct25Completion.toFixed(1), '%', `(${stats.games25Completion}/${stats.eligible})`)}
                            ${formatStatRow('⭐ 100% Achievement Completion', stats.pct100Completion.toFixed(1), '%', `(${stats.games100Completion}/${stats.eligible})`)}
                            ${formatStatRow('🎗️ Avg. Achievement Percentage', stats.compPct.toFixed(1), '%')}
                            ${formatStatRow('⏱️ Games with any Playtime', stats.pctAnyHours.toFixed(1), '%', `(${stats.anyHours}/${stats.gamesWon})`, true)}
                            ${formatStatRow('⏰ Avg. Game Playtime', stats.avgHours.toFixed(1), 'h', '', true)}
                        </div>
                        ${scanState.userPrivate[username] ? '<div style="margin-top:10px; color:#ff4c4c;">🔒 Steam profile is private</div>' : ''}
                    </div>

                    <div style="flex: 1; min-width: 250px; display: flex; flex-direction: column; justify-content: flex-end;">
                        <div style="text-align: center; font-size: 0.85em; font-weight: bold; margin-bottom: 30px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7;">
                            Play Rate Trend
                        </div>
                        ${renderChart(stats.yearlyData)}
                    </div>
                </div>
            `;
        }

        if (fullScan && !scanState.userPrivate[username]) {
            saveUserStatsToCache(username, stats);
            refreshAnnotations();
        }

        render(wins);
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
        if (!resultsWrap) return;

        // Remove tables
        resultsWrap.querySelectorAll('table').forEach(t => t.remove());

        // Clean up view toggle & action buttons
        const elementsToRemove = [
            '#dismiss-table',
            '#write-csv',
            '#flat-view',
            '#winners-view',
            '#back-to-summary',
            '#toggle-missing-filter',
            '.sg-back-to-top'
        ];

        elementsToRemove.forEach(sel => {
            resultsWrap.querySelectorAll(sel).forEach(el => el.remove());
        });
    }

    /************ RENDER SUMMARY ************/
    function renderSummary(summary, membersSet = new Set()) {
        scanState.viewMode = 'summary';
        scanState.activeUser = null;
        scanState.showMissingOnly = false; // Reset missing toggle filter on summary view

        // Clear existing header elements including missing filter toggle
        clearResults();
        resultsWrap.querySelector('#toggle-missing-filter')?.remove();

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
            clearResults();
            if (typeof status === 'function') status('');
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
                exportTableToCSV(table, `steamgifts-summary-${new Date().toISOString().slice(0,10)}`);
            }
        };

        resultsWrap.appendChild(csvBtn);

        resultsWrap.style.maxHeight = '70vh';
        resultsWrap.style.overflowY = 'auto';

        const flatViewBtn = document.createElement('button');
        flatViewBtn.id = 'flat-view';
        flatViewBtn.innerText = 'Giveaways View';
        flatViewBtn.title = 'Show a list of all games won';
        flatViewBtn.style = `float: left; margin-bottom: 5px; margin-right: 5px; padding: 2px 6px; font-size: 12px; background:#2a475e; color:#fff; border:none; border-radius:3px; cursor:pointer;`;
        flatViewBtn.onclick = () => {
            renderFlatView();
        };
        resultsWrap.appendChild(flatViewBtn);

        // 1. CALCULATE GLOBAL TOTALS
        const totals = {
            wins: 0,
            eligible: 0,
            any: 0,
            twentyFive: 0,
            hundred: 0,
            hours: 0,
            anyHoursWins: 0,
            usersWithPlaytime: 0,
            unlocked: 0,
            available: 0
        };

        summary.forEach(u => {
            totals.wins += u.gamesWon || 0;
            totals.eligible += u.eligible || 0;
            totals.any += u.gamesAnyCompletion || 0;
            totals.twentyFive += u.games25Completion || 0;
            totals.hundred += u.games100Completion || 0;
            totals.hours += u.totalHours || 0;
            totals.anyHoursWins += u.anyHours || 0;
            if (u.totalHours > 0) totals.usersWithPlaytime++;
            totals.unlocked += (u.totalUnlocked || 0);
            totals.available += (u.totalAvailable || 0);
        });

        const avg = {
            pctAny: totals.eligible ? (Math.round((totals.any / totals.eligible) * 1000) / 10) : 0,
            pct25: totals.eligible ? (Math.round((totals.twentyFive / totals.eligible) * 1000) / 10) : 0,
            pct100: totals.eligible ? (Math.round((totals.hundred / totals.eligible) * 1000) / 10) : 0,
            pctComp: totals.available ? (Math.round((totals.unlocked / totals.available) * 1000) / 10) : 0,
            perPlayedWin: totals.anyHoursWins ? (totals.hours / totals.anyHoursWins) : 0
        };

        const table = document.createElement('table');
        table.id = 'sg-summary-table';

        const colgroup = document.createElement('colgroup');
        colgroup.innerHTML = `
            <col style="width: 21%">
            <col style="width: 10%">
            <col style="width: 15%">
            <col style="width: 15%">
            <col style="width: 15%">
            <col style="width: 12%">
            <col style="width: 12%">
        `;
        table.appendChild(colgroup);

        const headers = ['User', 'Wins', '% Started<br>(>0🏆)', '% Played<br>(>25%🏆)', '% Complete<br>(100%🏆)', 'Avg 🏆 %', 'Playtime'];
        const thead = document.createElement('thead');

        // New Average Row
        const trAvg = document.createElement('tr');
        trAvg.className = 'sticky-avg';
        trAvg.innerHTML = `
            <td>GLOBAL SUMMARY</td>
            <td>${totals.wins}</td>
            <td>${avg.pctAny}% <small>(${totals.any}/${totals.eligible})</small></td>
            <td>${avg.pct25}% <small>(${totals.twentyFive}/${totals.eligible})</small></td>
            <td>${avg.pct100}% <small>(${totals.hundred}/${totals.eligible})</small></td>
            <td>${avg.pctComp}%</td>
            <td><div title="Average hours per played win">Avg: ${avg.perPlayedWin.toFixed(1)}h</div></td>
        `;
        thead.appendChild(trAvg);

        const avgHeight = trAvg.offsetHeight || 30;

        const trHead = document.createElement('tr');
        trHead.className = 'sticky-header';
        headers.forEach((h, i) => {
            const th = document.createElement('th');
            th.innerHTML = h;
            th.style.top = `${avgHeight}px`;
            th.onclick = () => sortTable(table, i);
            trHead.appendChild(th);
        });

        thead.appendChild(trHead);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        const cols = ['gamesWon', 'pctAnyCompletion', 'pct25Completion', 'pct100Completion', 'compPct', 'totalHours'];

        summary.forEach(u => {
            const tr = document.createElement('tr');

            // User Column
            const tdUser = document.createElement('td');
            const a = document.createElement('a');
            a.href = '#';
            a.onclick = (e) => { e.preventDefault(); showUserDetail(u.username); };
            a.innerText = scanState.userDisplay[u.username] ?? u.username;
            tdUser.appendChild(a);
            tr.appendChild(tdUser);

            // Data Columns
            cols.forEach((c) => {
                const td = document.createElement('td');

                const isPrivateUser = !!scanState.userPrivate[u.username];
                const isWinCol = c === 'gamesWon';
                const hasEligibleGames = u.eligible > 0;

                td.dataset.value = (isPrivateUser && !isWinCol) ? -1 : (u[c] ?? -1);

                const lockSpan = '<span title="User\'s Steam profile or game stats are private">🔒</span>';
                let display = (isPrivateUser && !isWinCol) ? lockSpan : (u[c] ?? 0);

                if (!isPrivateUser || isWinCol) {
                    if (c === 'totalHours') {
                        display = Number(display).toFixed(1);
                    }
                    else if (c === 'pctAnyCompletion') {
                        const val = hasEligibleGames ? `${u.pctAnyCompletion}%` : 'N/A';
                        display = `${val} <small style="opacity:0.7">(${u.gamesAnyCompletion}/${u.eligible})</small>`;
                    }
                    else if (c === 'pct25Completion') {
                        const val = hasEligibleGames ? `${u.pct25Completion}%` : 'N/A';
                        display = `${val} <small style="opacity:0.7">(${u.games25Completion}/${u.eligible})</small>`;
                    }
                    else if (c === 'pct100Completion') {
                        const val = hasEligibleGames ? `${u.pct100Completion}%` : 'N/A';
                        display = `${val} <small style="opacity:0.7">(${u.games100Completion}/${u.eligible})</small>`;
                    }
                    else if (c === 'compPct') {
                        display = hasEligibleGames ? `${display}%` : 'N/A';
                    }
                }

                td.innerHTML = display;
                tr.appendChild(td);
            });

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        resultsWrap.appendChild(table);

        attachBackToTop(resultsWrap);

        if (typeof summarySort !== 'undefined' && summarySort.col !== null) {
            sortTable(table, summarySort.col, summarySort.asc);
        }
        if (typeof saveScanState === 'function') saveScanState();
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
                url: `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${settings.steamApiKey}&steamid=${steamid}&include_appinfo=true&skip_unvetted_apps=false`,
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

    // Helper: Batch fetch achievement totals from ESGST
    async function fetchEsgstAchievements(appIds) {
        if (!appIds || appIds.length === 0) return {};

        const url = `https://esgst.rafaelgomes.xyz/api/games?app_ids=${appIds.join(',')}`;

        try {
            const res = await fetch(url);
            const data = await res.json();
            const results = {};

            const apps = data?.result?.found?.apps;

            if (apps && typeof apps === 'object') {
                for (const [appId, details] of Object.entries(apps)) {
                    results[appId] = details?.achievements ?? 0;
                }
            }

            return results;

        } catch (err) {
            console.warn('Failed to fetch ESGST achievement metadata:', err);
            return {};
        }
    }

    async function getSubPlaytime(steamid, subid, useSteamCache) {
        const apps = await getSubAppsCached(subid);
        const result = await getOwnedGamesCachedIDB(steamid, useSteamCache);

        const steamGamesMap = result.apps || {};
        let total = 0;
        let ownedCount = 0;

        for (const appid of apps) {
            if (steamGamesMap[appid] !== undefined) {
                ownedCount++;
                total += Number(steamGamesMap[appid]) || 0;
            }
        }

        // Returns an object containing both total minutes and missing state
        return {
            hours: total,
            isMissing: apps.length > 0 && ownedCount === 0 // All constituent apps are missing
        };
    }

    async function getSubAchievements(steamid, subid, useSteamCache, isMissing = false) {
        const apps = await getSubAppsCached(subid);
        let done = 0;
        let total = 0;

        // If all apps in sub package are missing/private, query ESGST for achievement totals
        if (isMissing) {
            const esgstMap = await fetchEsgstAchievements(apps);
            for (const appid of apps) {
                total += esgstMap[appid] || 0;
            }
            return total > 0 ? `0/${total}` : 'N/A';
        }

        // Standard API lookup for owned sub apps
        for (const appid of apps) {
            const val = await getAchievementsCachedIDB(steamid, appid, useSteamCache);

            if (typeof val !== 'string' || !val.includes('/')) {
                continue;
            }

            const parts = val.split('/').map(Number);
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

    function attachBackToTop(container) {
        const existing = container.querySelector('.sg-back-to-top');
        if (existing) existing.remove();

        const btn = document.createElement('div');
        btn.className = 'sg-back-to-top';
        btn.innerHTML = '︿';

        container.onscroll = () => {
            btn.style.display = container.scrollTop > 300 ? 'block' : 'none';
        };

        btn.onclick = () => {
            container.scrollTo({ top: 0, behavior: 'smooth' });
        };

        container.appendChild(btn);
    }

    function getMissingGameCount(results) {
        if (!Array.isArray(results)) return 0;
        return results.filter(r => r.isMissing).length;
    }

    function renderMissingToggleBtn(results, parentEl) {
        parentEl.querySelector('#toggle-missing-filter')?.remove();

        const missingCount = getMissingGameCount(results);
        if (missingCount === 0) return;

        const btn = document.createElement('button');
        btn.id = 'toggle-missing-filter';

        btn.innerText = scanState.showMissingOnly
            ? `✖ Showing ${missingCount} Private/Missing`
            : `⛔ ${missingCount} Private/Missing`;

        btn.title = scanState.showMissingOnly
            ? 'Click to show all games'
            : 'Click to filter and show only private/missing games';

        btn.style = `
            float: right;
            margin-bottom: 5px;
            margin-right: 5px;
            padding: 2px 6px;
            font-size: 11px;
            font-weight: bold;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            background: ${scanState.showMissingOnly ? '#ff4c4c' : '#e0a96d'};
            color: ${scanState.showMissingOnly ? '#ffffff' : '#1b2838'};
        `;

        btn.onclick = () => {
            scanState.showMissingOnly = !scanState.showMissingOnly;

            if (scanState.viewMode === 'flat') {
                renderFlatView();
            } else if (scanState.activeUser) {
                render(scanState.userMap[scanState.activeUser]);
            } else {
                render(results);
            }
        };

        parentEl.appendChild(btn);
    }

    // --- Shared DOM & Toolbar Helpers ---

    function createStyledButton(text, title, onClick, styleProps = {}) {
        const btn = document.createElement('button');
        btn.innerText = text;
        btn.title = title;
        btn.onclick = onClick;
        Object.assign(btn.style, {
            float: 'right',
            marginBottom: '5px',
            padding: '2px 6px',
            fontSize: '12px',
            background: '#2a475e',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            ...styleProps
        });
        return btn;
    }

    function setupToolbar(tableId, csvPrefix, extraLeftButtons = []) {
        clearResults();

        // Extra buttons on the left (e.g. Back To Summary / Winners View)
        extraLeftButtons.forEach(btn => resultsWrap.appendChild(btn));

        // Right-aligned CSV and Dismiss buttons
        const csvBtn = createStyledButton('CSV', 'Export table to CSV', () => {
            const table = document.getElementById(tableId);
            if (table) {
                exportTableToCSV(table, `${csvPrefix}-${new Date().toISOString().slice(0, 10)}`);
            }
        }, { marginRight: '5px' });

        const dismissBtn = createStyledButton('✖', 'Dismiss results', () => {
            panel.querySelector('table')?.remove();
            clearResults();
            if (typeof status === 'function') status('');
        });

        dismissBtn.id = 'dismiss-table';
        csvBtn.id = 'write-csv';

        resultsWrap.appendChild(dismissBtn);
        resultsWrap.appendChild(csvBtn);
    }

    // --- Shared Table Cell Formatters ---

    function buildTableCell(r, type) {
        const td = document.createElement('td');
        td.style = 'padding: 6px; border: 1px solid #444;';

        switch (type) {
            case 'name': {
                td.style.textAlign = 'left';
                td.style.overflow = 'hidden';
                td.style.textOverflow = 'ellipsis';
                td.style.whiteSpace = 'nowrap';

                // Build icon element helpers with tooltips
                const wlIcon = (r.wlonly && typeof highlightWLON !== 'undefined' && highlightWLON)
                    ? ' <span title="Whitelist-only giveaway">💙</span>'
                    : '';

                const missingIcon = r.isMissing
                    ? ' <span title="Game was not found in user\'s library. Possible reasons:\n1. The game was revoked or privated by the user\n2. The package is missing from the Steam store and couldn\'t be matched to an appid\n3. The app is a DLC that\'s missing the standard DLC tag">⛔</span>'
                    : '';

                const lockIcon = ' <span title="Invite-only giveaway">🔒</span>';

                if (r.url) {
                    const a = document.createElement('a');
                    a.href = r.url;
                    a.target = '_blank';
                    a.style = 'color:#66c0f4; text-decoration:none;';
                    a.innerText = r.name;

                    td.appendChild(a);
                    // Append html string for icons with title attributes
                    td.insertAdjacentHTML('beforeend', wlIcon + missingIcon);
                } else {
                    td.innerText = r.name;
                    td.style.color = '#888';
                    td.insertAdjacentHTML('beforeend', lockIcon + wlIcon + missingIcon);
                }
                break;
            }
            case 'date': {
                td.innerText = formatDateFromTimestamp(r.ts);
                td.dataset.value = r.ts ?? -1;
                break;
            }
            case 'winner': {
                td.style.overflow = 'hidden';
                td.style.textOverflow = 'ellipsis';
                td.style.textAlign = 'left';

                const aWin = document.createElement('a');
                aWin.href = '#';
                aWin.onclick = (e) => { e.preventDefault(); showUserDetail(r.winner); };
                aWin.innerText = scanState.userDisplay[r.winner] ?? r.winner;
                td.appendChild(aWin);
                break;
            }
            case 'achievements': {
                if (r.isMissing && r.ach && r.ach !== "N/A") {
                    td.innerText = r.ach;
                    td.title = 'Game not found in Steam library';
                    td.style.color = '#e01e6d';
                    td.dataset.value = 0;
                } else if (r.ach && r.ach.includes('/') && r.app) {
                    const [done, total] = r.ach.split('/').map(Number);
                    const a = document.createElement('a');
                    a.href = `https://steamcommunity.com/profiles/${r.steamid}/stats/${r.app}/achievements`;
                    a.target = '_blank';
                    a.style = 'color:#66c0f4; text-decoration:none;';
                    a.innerText = r.ach;
                    td.appendChild(a);
                    td.dataset.value = total > 0 ? done / total : 0;
                } else {
                    td.innerText = r.ach || 'N/A';
                    td.dataset.value = -1;
                }
                break;
            }
            case 'completion': {
                if (r.ach && r.ach.includes('/')) {
                    const [done, total] = r.ach.split('/').map(Number);
                    const pct = total > 0 ? Math.round((done / total) * 100) : -1;
                    td.innerText = pct >= 0 ? pct + '%' : 'N/A';
                    td.dataset.value = pct;
                } else {
                    td.innerText = 'N/A';
                }
                break;
            }
            case 'hours': {
                const hours = r.hours !== undefined ? Number(r.hours) / 60 : 0;
                td.innerText = hours.toFixed(1);
                td.dataset.value = hours;
                break;
            }
        }
        return td;
    }

    // --- Main Engine to Render Any Results Table ---

    function renderResultsTable({ tableId, rawResults, columns }) {
        // 1. Missing Toggle Filter
        renderMissingToggleBtn(rawResults, resultsWrap);
        const displayResults = scanState.showMissingOnly
            ? rawResults.filter(r => r.isMissing)
            : rawResults;

        resultsWrap.style.maxHeight = '70vh';
        resultsWrap.style.overflowY = 'auto';

        // 2. Table Creation
        const table = document.createElement('table');
        table.id = tableId;
        table.style = 'width: 100%; margin-top: 5px; border-collapse: collapse; table-layout: fixed; text-align: center; white-space: nowrap;';

        // 3. Colgroup
        const colgroup = document.createElement('colgroup');
        colgroup.innerHTML = columns.map(c => `<col style="width: ${c.width}">`).join('');
        table.appendChild(colgroup);

        // 4. Headers
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        columns.forEach((col, i) => {
            const th = document.createElement('th');
            th.innerText = col.label;
            th.style = 'cursor: pointer; padding: 6px; background: #2a475e; color: #fff; border: 1px solid #444;';
            th.onclick = () => sortTable(table, i);
            trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        table.appendChild(thead);

        // 5. Rows
        const tbody = document.createElement('tbody');
        displayResults.forEach(r => {
            const tr = document.createElement('tr');
            columns.forEach(col => {
                tr.appendChild(buildTableCell(r, col.type));
            });
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        resultsWrap.appendChild(table);
        attachBackToTop(resultsWrap);
    }

    function render(results) {
        let backBtn = null;
        if (scanState.activeUser && ['all', 'group'].includes(scanState.mode)) {
            backBtn = createStyledButton('← Back to Summary', 'Return to group summary', () => {
                scanState.activeUser = null;
                scanState.showMissingOnly = false;
                if (typeof status === 'function') {
                    status('');
                }
                renderSummary(scanState.summary, scanState.membersSet);
                if (typeof status === 'function') {
                    status(`Summary loaded for ${scanState.summary.length} users.`);
                }
            }, { float: 'left' });
            backBtn.id = 'back-to-summary';
        }

        setupToolbar('sg-user-table', 'steamgifts-user', backBtn ? [backBtn] : []);

        renderResultsTable({
            tableId: 'sg-user-table',
            rawResults: results,
            columns: [
                { label: 'Game', type: 'name', width: '45%' },
                { label: 'Date', type: 'date', width: '15%' },
                { label: 'Achievements', type: 'achievements', width: '15%' },
                { label: 'Completion %', type: 'completion', width: '15%' },
                { label: 'Hours', type: 'hours', width: '10%' }
            ]
        });
    }

    function renderFlatView() {
        scanState.viewMode = 'flat';
        const rawFlatResults = getFlatResults();

        let winnersBtn = null;
        if (!resultsWrap.querySelector('#winners-view')) {
            winnersBtn = createStyledButton('Winners View', 'Switch to Summary View', () => {
                scanState.viewMode = 'summary';
                scanState.showMissingOnly = false;
                renderSummary(scanState.summary, scanState.membersSet);
            }, { float: 'left' });
            winnersBtn.id = 'winners-view';
        }

        setupToolbar('sg-flat-table', 'steamgifts-giveaways', winnersBtn ? [winnersBtn] : []);

        renderResultsTable({
            tableId: 'sg-flat-table',
            rawResults: rawFlatResults,
            columns: [
                { label: 'Game', type: 'name', width: '32%' },
                { label: 'Date', type: 'date', width: '13%' },
                { label: 'Winner', type: 'winner', width: '20%' },
                { label: 'Achievements', type: 'achievements', width: '13%' },
                { label: 'Comp %', type: 'completion', width: '12%' },
                { label: 'Hours', type: 'hours', width: '10%' }
            ]
        });
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

    function isFullScan(username, whitelistOnly, fullCVOnly, reviewFilter, creatorFilter, startDateInput, endDateInput) {
        // Only valid on a user's Won page
        if (!isUserWonPage) return false;

        const urlUsername = location.pathname
                .split('/user/')[1]
                .split('/')[0]
                .toLowerCase();

        const usernameMatch = urlUsername === username.toLowerCase();

        const urlParams = new URLSearchParams(window.location.search);

        // Check for SG native filters
        const hasSgFilters = urlParams.has('search') || urlParams.has('type');

        // Check for your script's specific filters (Whitelist, CV, Date, etc.)
        const hasScriptFilters = whitelistOnly || fullCVOnly || reviewFilter || creatorFilter!== "" || startDateInput !== "" || endDateInput !== "";

        return !hasSgFilters && !hasScriptFilters && usernameMatch;
    }

    /************ MAIN ************/
    const runScan = async (useSteamCache) => {
        try {
            const mode = scanState.mode;
            const whitelistOnly = document.getElementById('sgWhitelistOnly').checked;
            const fullCVOnly = document.getElementById('sgFullCvOnly').checked;
            const reviewFilterEnabled = document.getElementById('sgReviewFilterEnabled').checked;
            const minReviews = Number(document.getElementById('sgMinReviewCount').value || 0);
            const minReviewScore = Number(document.getElementById('sgMinReviewScore').value || 0);

            const username = userInput.value.trim();
            scanState.userDisplay[username.toLowerCase()] ??= username;
            const creatorFilter = creatorInput.value.trim().toLowerCase();

            const startDateInput = document.getElementById('sgStartDate').value;
            const endDateInput   = document.getElementById('sgEndDate').value;

            const fullScan = isFullScan(username, whitelistOnly, fullCVOnly, reviewFilterEnabled, creatorFilter, startDateInput, endDateInput)

            // Convert to UNIX seconds (or null)
            const startTs = startDateInput
                ? Math.floor(new Date(startDateInput + 'T00:00:00Z').getTime() / 1000)
                : null;

            const endTs = endDateInput
                ? Math.floor(new Date(endDateInput + 'T23:59:59Z').getTime() / 1000)
                : null;

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
            if (creatorFilter) {
                filteredWins = filteredWins.filter(g => g.creator === creatorFilter);
            }

            /* -------------------------------------------------
               Ignore DLC filtering
            ------------------------------------------------- */
            if (ignoreDlcON) {
                status('Filtering DLC giveaways…');
                await ensureEsgstDlcData(filteredWins);
                filteredWins = filterOutDlcWins(filteredWins);
            }

            /* -------------------------------------------------
               Full CV filtering
            ------------------------------------------------- */
            if (fullCVOnly) {
                status('Filtering Full CV giveaways…');
                console.log (`filtering full CV`);
                await ensureEsgstCvData(filteredWins);
                filteredWins = getFullCVWins(filteredWins);
            }

            /* -------------------------------------------------
               Date range filtering
            ------------------------------------------------- */
            if (startTs || endTs) {
                filteredWins = filteredWins.filter(g => {
                    if (startTs && g.ts < startTs) return false;
                    if (endTs && g.ts > endTs) return false;
                    return true;
                });
            }

            /* -------------------------------------------------
               Review filtering
            ------------------------------------------------- */
            if (
                reviewFilterEnabled &&
                (minReviews > 0 || minReviewScore > 0)
            ) {
                status('Filtering by review requirements...');

                await ensureSteamMetaData(
                    filteredWins,
                    msg => status(msg)
                );

                filteredWins = getMinReviewWins(
                    filteredWins,
                    minReviews,
                    minReviewScore
                );
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
                let isPrivateUser = false;

                const res = await getOwnedGamesCachedIDB(steamid, useSteamCache);
                steamGamesMap = res.apps;
                isPrivateUser = !!res.private;

                scanState.userPrivate[user] = isPrivateUser;

                if (isPrivateUser) {
                    userWins.forEach(w => {
                        w.hours = null;
                        w.ach = null;
                        w.isMissing = false;
                    });
                    continue; // skip Steam processing for this user
                }
userWins.forEach(w => console.log(`App ${w.app} Found in steamGamesMap ${steamGamesMap[w.app]}`));
                // 1. Identify missing app wins prior to parallel worker execution
                const missingAppWins = userWins.filter(w => !w.isSub && w.app && steamGamesMap[w.app] === undefined);
                const missingAppIds = [...new Set(missingAppWins.map(w => w.app))];

                // 2. Fetch total achievements count from ESGST for all missing games in one batch request
                const esgstAchMap = await fetchEsgstAchievements(missingAppIds);

                missingAppWins.forEach(w => {
                    const totalAch = esgstAchMap[w.app] || 0;
                    w.ach = `0/${totalAch}`;
                    w.hours = 0;
                });

                initSteamProgress(userWins.length);
                let done = 0;

                // Worker that processes ONE win
                async function processWin(w) {
                    if (w.isSub && w.sub) {
                        try {
                            const subData = await getSubPlaytime(steamid, w.sub, useSteamCache);
                            w.hours = subData.hours;
                            w.isMissing = subData.isMissing;
                            w.ach = await getSubAchievements(steamid, w.sub, useSteamCache, w.isMissing);
                            console.log (`sub name : ${w.name}, sub missing: ${w.isMissing}, sub ach: ${w.ach}`);
                        } catch {
                            w.hours = 0;
                            w.isMissing = true;
                            w.ach = 'N/A';
                        }
                    } else {
                        const isOwned = steamGamesMap[w.app] !== undefined;

                        if (isOwned) {
                            w.isMissing = false;
                            w.hours = steamGamesMap[w.app] ?? 0;
                            try {
                                w.ach = await getAchievementsCachedIDB(steamid, w.app, useSteamCache);
                            } catch {
                                w.ach = 'N/A';
                            }
                        } else {
                            // Missing/Hidden Standalone Game
                            w.isMissing = true;
                            w.hours = 0;

                            const totalAch = esgstAchMap[w.app] || 0;
                            w.ach = totalAch > 0 ? `0/${totalAch}` : 'N/A';
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
                showUserDetail(scanState.activeUser, fullScan);
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
    refreshAnnotations();
})();
