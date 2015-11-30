
// Create the popup iframe.
function setupDashboard() {
	var iframe = document.createElement('iframe');
	iframe.id = 'dashboard';
	iframe.src = 'https://goodblock.org/app/dashboard/';
	var parent = document.getElementById('dashboard-container');
	parent.appendChild(iframe);		      
}

window.onload = function(e){ 
	// Delay to allow for quicker popup loading.
	setTimeout(function() {
		setupDashboard();
	}, 10);
}

var popupData;
var dfPaneBuilt = false;
var reIP = /^\d+(?:\.\d+){1,3}$/;
var reSrcHostnameFromRule = /^d[abn]:([^ ]+) ([^ ]+) ([^ ]+)/;
var scopeToSrcHostnameMap = {
    '/': '*',
    '.': ''
};
var threePlus = '+++';
var threeMinus = '−−−';
var sixSpace = '\u2007\u2007\u2007\u2007\u2007\u2007';
var dfHotspots = null;
var hostnameToSortableTokenMap = {};
var allDomains = {};
var allDomainCount = 0;
var allHostnameRows = [];
var touchedDomainCount = 0;
var rowsToRecycle = uDom();
var cachedPopupHash = '';
var vcEarnedStr = vAPI.i18n('vcEarnedStats');
var impactStatsStr = vAPI.i18n('impactStats');
var impactTextStr = vAPI.i18n('impactText');
var noImpactStr = vAPI.i18n('noImpact');
var domainsHitStr = vAPI.i18n('popupHitDomainCount');
var reNetworkRelatedURL = /^(?:ftps?|https?|wss?):\/\//;

/******************************************************************************/

// https://github.com/chrisaljoudi/httpswitchboard/issues/345

var messager = vAPI.messaging.channel('popup.js');

/******************************************************************************/

var calculateImpact = function(days) {
    var value;
    var units;
    if (days >= 7 && days < 30) {
        value = Math.round(days / 7);
        units = (value == 1) ? 'week' : 'weeks';
    } else if (days >= 30 && days < 365) {
        value = Math.round(days / 30);
        units = (value == 1) ? 'month' : 'months';
    } else {
        value = days;
        units = (value == 1) ? 'day' : 'days';
    }
    var impact = {
        'value': value,
        'units': units,
    };
    return impact
}

/******************************************************************************/

var cachePopupData = function(data) {
    popupData = {};
    scopeToSrcHostnameMap['.'] = '';
    hostnameToSortableTokenMap = {};

    if ( typeof data !== 'object' ) {
        return popupData;
    }
    popupData = data;
    scopeToSrcHostnameMap['.'] = popupData.pageHostname || '';
    var hostnameDict = popupData.hostnameDict;
    if ( typeof hostnameDict !== 'object' ) {
        return popupData;
    }
    var domain, prefix;
    for ( var hostname in hostnameDict ) {
        if ( hostnameDict.hasOwnProperty(hostname) === false ) {
            continue;
        }
        domain = hostnameDict[hostname].domain;
        if ( domain === popupData.pageDomain ) {
            domain = '\u0020';
        }
        prefix = hostname.slice(0, 0 - domain.length);
        hostnameToSortableTokenMap[hostname] = domain + prefix.split('.').reverse().join('.');
    }
    return popupData;
};

/******************************************************************************/

var hashFromPopupData = function(reset) {
    // It makes no sense to offer to refresh the behind-the-scene scope
    if ( popupData.pageHostname === 'behind-the-scene' ) {
        uDom('body').toggleClass('dirty', false);
        return;
    }

    var hasher = [];
    var rules = popupData.firewallRules;
    var rule;
    for ( var key in rules ) {
        if ( rules.hasOwnProperty(key) === false ) {
            continue;
        }
        rule = rules[key];
        if ( rule !== '' ) {
            hasher.push(rule);
        }
    }
    hasher.push(uDom('body').hasClass('off'));

    var hash = hasher.sort().join('');
    if ( reset ) {
        cachedPopupHash = hash;
    }
    uDom('body').toggleClass('dirty', hash !== cachedPopupHash);
};

/******************************************************************************/

var formatNumber = function(count) {
    if (typeof count === 'number') {
        if (count >= 1000 && count < 1000000) {
            return (Math.round(count * 100 / 1000) / 100).toFixed(1) + 'K';
        } else if (count >= 1000000) {
            return (Math.round(count * 100 / 1000000) / 100).toFixed(1) + 'M';
        } else {
            return count.toLocaleString()
        }
    }
    return '';
};

/******************************************************************************/

var rulekeyCompare = function(a, b) {
    var ha = a.slice(2, a.indexOf(' ', 2));
    if ( !reIP.test(ha) ) {
        ha = hostnameToSortableTokenMap[ha] || '';
    }
    var hb = b.slice(2, b.indexOf(' ', 2));
    if ( !reIP.test(hb) ) {
        hb = hostnameToSortableTokenMap[hb] || '';
    }
    return ha.localeCompare(hb);
};

/******************************************************************************/

var addFirewallRow = function(des) {
    var row = rowsToRecycle.pop();
    if ( row.length === 0 ) {
        row = uDom('#templates > div:nth-of-type(1)').clone();
    }

    row.descendants('[data-des]').attr('data-des', des);
    row.descendants('span:nth-of-type(1)').text(punycode.toUnicode(des));

    var hnDetails = popupData.hostnameDict[des] || {};
    var isDomain = des === hnDetails.domain;
    row.toggleClass('isDomain', isDomain)
       .toggleClass('isSubDomain', !isDomain)
       .toggleClass('allowed', hnDetails.allowCount !== 0)
       .toggleClass('blocked', hnDetails.blockCount !== 0)
       .toggleClass('totalAllowed', hnDetails.totalAllowCount !== 0)
       .toggleClass('totalBlocked', hnDetails.totalBlockCount !== 0);

    row.appendTo('#firewallContainer');

    return row;
};

/******************************************************************************/

var updateFirewallCell = function(scope, des, type, rule) {
    var selector = '#firewallContainer span[data-src="' + scope + '"][data-des="' + des + '"][data-type="' + type + '"]';
    var cell = uDom(selector);

    // This should not happen
    if ( cell.length === 0 ) {
        return;
    }

    cell.removeClass();
    var action = rule.charAt(1);
    if ( action !== '' ) {
        cell.toggleClass(action + 'Rule', true);
    }

    // Use dark shade visual cue if the filter is specific to the cell.
    var ownRule = false;
    var matches = reSrcHostnameFromRule.exec(rule);
    if ( matches !== null ) {
        ownRule = (matches[2] !== '*' || matches[3] === type) &&
                  (matches[2] === des) &&
                  (matches[1] === scopeToSrcHostnameMap[scope]);
    }
    cell.toggleClass('ownRule', ownRule);

    if ( scope !== '.' || des === '*' ) {
        return;
    }

    // IMPORTANT: It is completely assumed the first node is a TEXT_NODE, so
    //            ensure this in the HTML file counterpart when you make
    //            changes
    var textNode = cell.nodeAt(0).firstChild;

    // Remember this may be a cell from a reused row, we need to clear text
    // content if we can't compute request counts.
    if ( popupData.hostnameDict.hasOwnProperty(des) === false ) {
        textNode.nodeValue = ' ';
        return;
    }

    var hnDetails = popupData.hostnameDict[des];
    var aCount = hnDetails.allowCount;
    var bCount = hnDetails.blockCount;
    if ( aCount !== 0 || bCount !== 0 ) {
        // https://github.com/chrisaljoudi/uBlock/issues/471
        aCount = Math.min(Math.ceil(Math.log(aCount + 1) / Math.LN10), 3);
        bCount = Math.min(Math.ceil(Math.log(bCount + 1) / Math.LN10), 3);
        textNode.nodeValue = threePlus.slice(0, aCount) +
                             sixSpace.slice(aCount + bCount) +
                             threeMinus.slice(0, bCount);
    } else {
        textNode.nodeValue = ' ';
    }

    if ( hnDetails.domain !== des ) {
        return;
    }

    textNode = cell.nodeAt(1).firstChild;
    aCount = hnDetails.totalAllowCount;
    bCount = hnDetails.totalBlockCount;
    if ( aCount !== 0 || bCount !== 0 ) {
        // https://github.com/chrisaljoudi/uBlock/issues/471
        aCount = Math.min(Math.ceil(Math.log(aCount + 1) / Math.LN10), 3);
        bCount = Math.min(Math.ceil(Math.log(bCount + 1) / Math.LN10), 3);
        textNode.nodeValue = threePlus.slice(0, aCount) +
                             sixSpace.slice(aCount + bCount) +
                             threeMinus.slice(0, bCount);
    } else {
        textNode.nodeValue = ' ';
    }
};

/******************************************************************************/

var updateAllFirewallCells = function() {
    var rules = popupData.firewallRules;
    for ( var key in rules ) {
        if ( rules.hasOwnProperty(key) === false ) {
            continue;
        }
        updateFirewallCell(
            key.charAt(0),
            key.slice(2, key.indexOf(' ', 2)),
            key.slice(key.lastIndexOf(' ') + 1),
            rules[key]
        );
    }

    uDom('#firewallContainer').toggleClass(
        'dirty',
        popupData.matrixIsDirty === true
    );
};

/******************************************************************************/

var buildAllFirewallRows = function() {
    // Do this before removing the rows
    if ( dfHotspots === null ) {
        dfHotspots = uDom('#actionSelector').on('click', 'span', setFirewallRuleHandler);
    }
    dfHotspots.detach();

    // Remove and reuse all rows: the order may have changed, we can't just
    // reuse them in-place.
    rowsToRecycle = uDom('#firewallContainer > div:nth-of-type(7) ~ div').detach();

    var n = allHostnameRows.length;
    for ( var i = 0; i < n; i++ ) {
        addFirewallRow(allHostnameRows[i]);
    }

    if ( dfPaneBuilt !== true ) {
        uDom('#firewallContainer')
            .on('click', 'span[data-src]', unsetFirewallRuleHandler)
            .on('mouseenter', '[data-src]', mouseenterCellHandler)
            .on('mouseleave', '[data-src]', mouseleaveCellHandler);
        dfPaneBuilt = true;
    }
    setTimeout(positionDfPaneFloaters, 50);
    updateAllFirewallCells();
};

/******************************************************************************/

var renderPrivacyExposure = function() {
    allDomains = {};
    allDomainCount = touchedDomainCount = 0;
    allHostnameRows = [];

    // Sort hostnames. First-party hostnames must always appear at the top
    // of the list.
    var desHostnameDone = {};
    var keys = Object.keys(popupData.firewallRules)
                     .sort(rulekeyCompare);
    var key, des, hnDetails;
    for ( var i = 0; i < keys.length; i++ ) {
        key = keys[i];
        des = key.slice(2, key.indexOf(' ', 2));
        // Specific-type rules -- these are built-in
        if ( des === '*' || desHostnameDone.hasOwnProperty(des) ) {
            continue;
        }
        hnDetails = popupData.hostnameDict[des] || {};
        if ( allDomains.hasOwnProperty(hnDetails.domain) === false ) {
            allDomains[hnDetails.domain] = false;
            allDomainCount += 1;
        }
        if ( hnDetails.allowCount !== 0 ) {
            if ( allDomains[hnDetails.domain] === false ) {
                allDomains[hnDetails.domain] = true;
                touchedDomainCount += 1;
            }
        }
        allHostnameRows.push(des);
        desHostnameDone[des] = true;
    }

    // Domain of the page must always be included (if there is one)
    if (
        allDomains.hasOwnProperty(popupData.pageDomain) === false &&
        reNetworkRelatedURL.test(popupData.rawURL)
    ) {
        allHostnameRows.push(popupData.pageDomain);
        allDomains[popupData.pageDomain] = false;
        allDomainCount += 1;
    }

    var summary = domainsHitStr.replace('{{count}}', touchedDomainCount.toLocaleString())
                               .replace('{{total}}', allDomainCount.toLocaleString());
    uDom('#popupHitDomainCount').text(summary);
};

/******************************************************************************/

var positionDfPaneFloaters = function() {
    // The padlock must be manually positioned:
    // - Its horizontal position depends on whether there is a vertical
    //   scrollbar.
    var firewallContainer = document.getElementById('firewallContainer'),
        scopeIcons = document.getElementById('scopeIcons'),
        rect = firewallContainer.getBoundingClientRect(),
        rectLeft = rect.left,
        rectWidth = rect.width;
    document.getElementById('saveRules').style.setProperty('left', (rectLeft + 4) + 'px');
    // So must be the scope icons.
    // - They need to match up with the table
    scopeIcons.style.setProperty('left', rectLeft + 'px');
    scopeIcons.style.setProperty('width', rectWidth + 'px');
};

// Assume everything has to be done incrementally.

var renderPopup = function() {

    if ( popupData.tabTitle ) {
        document.title = popupData.appName + ' - ' + popupData.tabTitle;
    }

    uDom('#appname').text(popupData.appName);
    uDom('#version').text(popupData.appVersion);
    uDom('body').toggleClass('advancedUser', popupData.advancedUserEnabled);

    var whiteListStatus = (popupData.pageURL === '') ||
        (!popupData.netFilteringSwitch) ||
        (popupData.pageHostname === 'behind-the-scene' && !popupData.advancedUserEnabled);

    uDom('body').toggleClass(
        'off',
        whiteListStatus
    );
    
    document.getElementById("switch").checked = !whiteListStatus;

    // If you think the `=== true` is pointless, you are mistaken
    uDom('#gotoLog').toggleClass('enabled', popupData.canRequestLog === true)
                    .attr('href', 'devtools.html?tabId=' + popupData.tabId);
    uDom('#gotoPick').toggleClass('enabled', popupData.canElementPicker === true);

    var text;

    var adsViewed = popupData.adsViewed;
    var conversion = popupData.vcConversion;
    var totalVc = adsViewed * conversion;
    if ( totalVc === 0 ) {
        text = formatNumber(0);
    } else {
        text = vcEarnedStr.replace('{{count}}', formatNumber(totalVc));
    }
    uDom('#vc-earned').text(text);

    var impact = calculateImpact(adsViewed);
    var impactAmount = impact.value;
    var impactUnits = vAPI.i18n(impact.units);

    text = impactStatsStr.replace('{{amount}}', formatNumber(impactAmount))
                   .replace('{{units}}', impactUnits.toUpperCase());
    uDom('#total-impact').text(text);
    
    var water_dot_org = '<a target="_blank" href="http://www.water.org/">water.org</a>';
    if ( impactAmount === 0 ) {
        text = noImpactStr.replace('{{name}}', water_dot_org);
    } else {
        text = impactTextStr.replace('{{amount}}', formatNumber(impactAmount))
                       .replace('{{units}}', impactUnits)
                       .replace('{{name}}', water_dot_org);
    }
    uDom('#impact-text').html(text);

    // This will collate all domains, touched or not
    renderPrivacyExposure();
};

/******************************************************************************/

var toggleNetFilteringSwitch = function(ev) {

    if ( !popupData || !popupData.pageURL ) {
        return;
    }
    if ( popupData.pageHostname === 'behind-the-scene' && !popupData.advancedUserEnabled ) {
        return;
    }
    messager.send({
        what: 'toggleNetFiltering',
        url: popupData.pageURL,
        scope: ev.ctrlKey || ev.metaKey ? 'page' : '',
        state: !uDom('body').toggleClass('off').hasClass('off'),
        tabId: popupData.tabId
    });

    hashFromPopupData();
};

/******************************************************************************/

var gotoPick = function() {
    messager.send({
        what: 'gotoPick',
        tabId: popupData.tabId,
        select: true
});

    vAPI.closePopup();
};

/******************************************************************************/

var gotoURL = function(ev) {
    if ( this.hasAttribute('href') === false) {
        return;
    }

    ev.preventDefault();

    messager.send({
        what: 'gotoURL',
        details: {
            url: this.getAttribute('href'),
            select: true,
            index: -1
        }
    });

    vAPI.closePopup();
};

/******************************************************************************/

var toggleFirewallPane = function() {
    if ( popupData.advancedUserEnabled === false ) {
        return;
    }
    popupData.dfEnabled = !popupData.dfEnabled;

    messager.send({
        what: 'userSettings',
        name: 'dynamicFilteringEnabled',
        value: popupData.dfEnabled
    });

    // https://github.com/chrisaljoudi/uBlock/issues/996
    // Remember the last state of the firewall pane. This allows to
    // configure the popup size early next time it is opened, which means a
    // less glitchy popup at open time.
    dfPaneVisibleStored = popupData.dfEnabled;
    vAPI.localStorage.setItem('popupFirewallPane', dfPaneVisibleStored);

    // Dynamic filtering pane may not have been built yet
    uDom('#panes').toggleClass('dfEnabled', popupData.dfEnabled);
    if ( popupData.dfEnabled && dfPaneBuilt === false ) {
        buildAllFirewallRows();
    }
};

/******************************************************************************/

var mouseenterCellHandler = function() {
    if ( uDom(this).hasClass('ownRule') === false ) {
        dfHotspots.appendTo(this);
    }
};

var mouseleaveCellHandler = function() {
    dfHotspots.detach();
};

/******************************************************************************/

var setFirewallRule = function(src, des, type, action, persist) {
    // This can happen on pages where uBlock does not work
    if ( typeof popupData.pageHostname !== 'string' || popupData.pageHostname === '' ) {
        return;
    }
    var onFirewallRuleChanged = function(response) {
        cachePopupData(response);
        updateAllFirewallCells();
        hashFromPopupData();
    };
    messager.send({
        what: 'toggleFirewallRule',
        tabId: popupData.tabId,
        pageHostname: popupData.pageHostname,
        srcHostname: src,
        desHostname: des,
        requestType: type,
        action: action,
        persist: persist
    }, onFirewallRuleChanged);
};

/******************************************************************************/

var unsetFirewallRuleHandler = function(ev) {
    var cell = uDom(this);
    setFirewallRule(
        cell.attr('data-src') === '/' ? '*' : popupData.pageHostname,
        cell.attr('data-des'),
        cell.attr('data-type'),
        0,
        ev.ctrlKey || ev.metaKey
    );
    dfHotspots.appendTo(cell);
};

/******************************************************************************/

var setFirewallRuleHandler = function(ev) {
    var hotspot = uDom(this);
    var cell = hotspot.ancestors('[data-src]');
    if ( cell.length === 0 ) {
        return;
    }
    var action = 0;
    var hotspotId = hotspot.attr('id');
    if ( hotspotId === 'dynaAllow' ) {
        action = 2;
    } else if ( hotspotId === 'dynaNoop' ) {
        action = 3;
    } else {
        action = 1;
    }
    setFirewallRule(
        cell.attr('data-src') === '/' ? '*' : popupData.pageHostname,
        cell.attr('data-des'),
        cell.attr('data-type'),
        action,
        ev.ctrlKey || ev.metaKey
    );
    dfHotspots.detach();
};

/******************************************************************************/

var reloadTab = function() {
    messager.send({ what: 'reloadTab', tabId: popupData.tabId, select: true });

    // Polling will take care of refreshing the popup content

    // https://github.com/chrisaljoudi/uBlock/issues/748
    // User forces a reload, assume the popup has to be updated regardless if
    // there were changes or not.
    popupData.contentLastModified = -1;

    // No need to wait to remove this.
    uDom('body').toggleClass('dirty', false);
};

/******************************************************************************/

var toggleMinimize = function() {
    var elem = uDom('#firewallContainer');
    elem.toggleClass('minimized');
    popupData.firewallPaneMinimized = elem.hasClass('minimized');
    messager.send({
        what: 'userSettings',
        name: 'firewallPaneMinimized',
        value: popupData.firewallPaneMinimized
    });
};

/******************************************************************************/

var saveFirewallRules = function() {
    messager.send({
        what: 'saveFirewallRules',
        srcHostname: popupData.pageHostname,
        desHostnames: popupData.hostnameDict
    });
    uDom('#firewallContainer').removeClass('dirty');
};

/******************************************************************************/

var flushFirewallRules = function() {
    messager.send({
        what: 'flushFirewallRules',
        srcHostname: popupData.pageHostname,
        desHostnames: popupData.hostnameDict
    });
    popupData.contentLastModified = -1;
    uDom('#firewallContainer').removeClass('dirty');
};

/******************************************************************************/
// Poll for changes.
//
// I couldn't find a better way to be notified of changes which can affect
// popup content, as the messaging API doesn't support firing events accurately
// from the main extension process to a specific auxiliary extension process:
//
// - broadcasting() is not an option given there could be a lot of tabs opened,
//   and maybe even many frames within these tabs, i.e. unacceptable overhead
//   regardless of whether the popup is opened or not.
//
// - Modifying the messaging API is not an option, as this would require
//   revisiting all platform-specific code to support targeted broadcasting,
//   which who knows could be not so trivial for some platforms.
//
// A well done polling is a better anyways IMO, I prefer that data is pulled
// on demand rather than forcing the main process to assume a client may need
// it and thus having to push it all the time unconditionally.

var pollForContentChange = (function() {
    var pollTimer = null;

    var pollCallback = function() {
        pollTimer = null;
        messager.send(
            {
                what: 'hasPopupContentChanged',
                tabId: popupData.tabId,
                contentLastModified: popupData.contentLastModified
            },
            queryCallback
        );
    };

    var queryCallback = function(response) {
        if ( response ) {
            getPopupData(popupData.tabId);
            return;
        }
        poll();
    };

    var poll = function() {
        if ( pollTimer !== null ) {
            return;
        }
        pollTimer = setTimeout(pollCallback, 1500);
    };

    return poll;
})();

/******************************************************************************/

var getPopupData = function(tabId) {
    var onDataReceived = function(response) {
        cachePopupData(response);
        renderPopup();
        hashFromPopupData(true);
        pollForContentChange();
    };
    messager.send({ what: 'getPopupData', tabId: tabId }, onDataReceived);
};

/******************************************************************************/

// Make menu only when popup html is fully loaded

uDom.onLoad(function () {

    var tabId = null; //If there's no tab ID specified in the query string, it will default to current tab.

    // Extract the tab id of the page this popup is for
    var matches = window.location && window.location.search.match(/[\?&]tabId=([^&]+)/);
    if (matches && matches.length === 2) {
        tabId = matches[1];
    }

    getPopupData(tabId);
    uDom('#switch').on('click', toggleNetFilteringSwitch);
    uDom('#refresh').on('click', reloadTab);
});


