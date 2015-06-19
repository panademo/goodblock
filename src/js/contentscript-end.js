/*******************************************************************************

    µBlock - a browser extension to block requests.
    Copyright (C) 2014 Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/chrisaljoudi/uBlock
*/

/* global vAPI, HTMLDocument */

/******************************************************************************/

// Injected into content pages

(function() {

'use strict';

/******************************************************************************/

var numAds = 0;
// https://github.com/chrisaljoudi/uBlock/issues/464
if ( document instanceof HTMLDocument === false ) {
    //console.debug('contentscript-end.js > not a HTLMDocument');
    return false;
}

if ( !vAPI ) {
    //console.debug('contentscript-end.js > vAPI not found');
    return;
}

// https://github.com/chrisaljoudi/uBlock/issues/587
// Pointless to execute without the start script having done its job.
if ( !vAPI.contentscriptStartInjected ) {
    return;
}

// https://github.com/chrisaljoudi/uBlock/issues/456
// Already injected?
if ( vAPI.contentscriptEndInjected ) {
    //console.debug('contentscript-end.js > content script already injected');
    return;
}
vAPI.contentscriptEndInjected = true;
vAPI.styles = vAPI.styles || [];

/******************************************************************************/
/******************************************************************************/

var shutdownJobs = (function() {
    var jobs = [];

    return {
        add: function(job) {
            jobs.push(job);
        },
        exec: function() {
            console.debug('Shutting down filtering...');
            var job;
            while ( job = jobs.pop() ) {
                job();
            }
        }
    };
})();

/******************************************************************************/
/******************************************************************************/

var messager = vAPI.messaging.channel('contentscript-end.js');

// https://github.com/gorhill/uMatrix/issues/144
shutdownJobs.add(function() {
    messager.close();
});

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/789
// Be sure that specific cosmetic filters are still applied.
// Executed once, then flushed from memory.

(function() {
    // Were there specific cosmetic filters?
    if ( vAPI.specificHideStyle instanceof HTMLStyleElement === false ) {
        return;
    }
    // Is our style tag still in the DOM? (the guess is whatever parent there
    // is, it is in the DOM)
    if ( vAPI.specificHideStyle.parentNode !== null ) {
        return;
    }
    // Put it back
    var parent = document.head || document.documentElement;
    if ( parent ) {
        parent.appendChild(vAPI.specificHideStyle);
    }
})();

/******************************************************************************/
/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/7

var uBlockCollapser = (function() {
    var timer = null;
    var requestId = 1;
    var newRequests = [];
    var pendingRequests = {};
    var pendingRequestCount = 0;
    var srcProps = {
        'embed': 'src',
        'iframe': 'src',
        'img': 'src',
        'object': 'data'
    };

    var PendingRequest = function(target, tagName, attr) {
        this.id = requestId++;
        this.target = target;
        this.tagName = tagName;
        this.attr = attr;
        pendingRequests[this.id] = this;
        pendingRequestCount += 1;
    };

    // Because a while ago I have observed constructors are faster than
    // literal object instanciations.
    var BouncingRequest = function(id, tagName, url) {
        this.id = id;
        this.tagName = tagName;
        this.url = url;
        this.collapse = false;
    };

    var onProcessed = function(response) {
        // https://github.com/gorhill/uMatrix/issues/144
        if ( response.shutdown ) {
            shutdownJobs.exec();
            return;
        }

        var requests = response.result;
        if ( requests === null || Array.isArray(requests) === false ) {
            return;
        }
        var selectors = [];
        var i = requests.length;
        var request, entry, target, value;
        while ( i-- ) {
            // console.log('Processing a filtering request.');
            request = requests[i];
            if ( pendingRequests.hasOwnProperty(request.id) === false ) {
                continue;
            }
            entry = pendingRequests[request.id];
            delete pendingRequests[request.id];
            pendingRequestCount -= 1;

            // https://github.com/chrisaljoudi/uBlock/issues/869
            if ( !request.collapse ) {
                continue;
            }

            target = entry.target;

            // https://github.com/chrisaljoudi/uBlock/issues/399
            // Never remove elements from the DOM, just hide them
            // target.style.setProperty('display', 'none', 'important');

            // https://github.com/chrisaljoudi/uBlock/issues/1048
            // Use attribute to construct CSS rule
            if ( value = target.getAttribute(entry.attr) ) {
                selectors.push(entry.tagName + '[' + entry.attr + '="' + value + '"]');
            }
        }
        if ( selectors.length !== 0 ) {
            messager.send({
                what: 'cosmeticFiltersInjected',
                type: 'net',
                hostname: window.location.hostname,
                selectors: selectors
            });
            var selectorStr = selectors.join(',\n'),
                style = document.createElement('style');
            // The linefeed before the style block is very important: do not remove!
            style.appendChild(document.createTextNode(selectorStr + '\n{display:none !important;}'));
            var parent = document.body || document.documentElement;
            if ( parent ) {
                parent.appendChild(style);
                vAPI.styles.push(style);
            }
        }
        // Renew map: I believe that even if all properties are deleted, an
        // object will still use more memory than a brand new one.
        if ( pendingRequestCount === 0 ) {
            pendingRequests = {};
        }
    };

    var send = function() {
        timer = null;
        messager.send({
            what: 'filterRequests',
            pageURL: window.location.href,
            pageHostname: window.location.hostname,
            requests: newRequests
        }, onProcessed);
        newRequests = [];
    };

    var process = function(delay) {
        if ( newRequests.length === 0 ) {
            return;
        }
        if ( delay === 0 ) {
            clearTimeout(timer);
            send();
        } else if ( timer === null ) {
            timer = setTimeout(send, delay || 20);
        }
    };

    // If needed eventually, we could listen to `src` attribute changes
    // for iframes.

    var add = function(target) {
        var tagName = target.localName;
        var prop = srcProps[tagName];
        if ( prop === undefined ) {
            return;
        }
        // https://github.com/chrisaljoudi/uBlock/issues/174
        // Do not remove fragment from src URL
        var src = target[prop];
        if ( typeof src !== 'string' || src === '' ) {
            return;
        }
        if ( src.lastIndexOf('http', 0) !== 0 ) {
            return;
        }
        var req = new PendingRequest(target, tagName, prop);
        newRequests.push(new BouncingRequest(req.id, tagName, src));
    };

    var iframeSourceModified = function(mutations) {
        var i = mutations.length;
        while ( i-- ) {
            addIFrame(mutations[i].target, true);
        }
        process();
    };
    var iframeSourceObserver = new MutationObserver(iframeSourceModified);
    var iframeSourceObserverOptions = {
        attributes: true,
        attributeFilter: [ 'src' ]
    };

    var addIFrame = function(iframe, dontObserve) {
        // https://github.com/gorhill/uBlock/issues/162
        // Be prepared to deal with possible change of src attribute.
        if ( dontObserve !== true ) {
            iframeSourceObserver.observe(iframe, iframeSourceObserverOptions);
        }

        var src = iframe.src;
        if ( src === '' || typeof src !== 'string' ) {
            return;
        }
        if ( src.lastIndexOf('http', 0) !== 0 ) {
            return;
        }
        var req = new PendingRequest(iframe, 'iframe', 'src');
        newRequests.push(new BouncingRequest(req.id, 'iframe', src));
    };

    var iframesFromNode = function(node) {
        if ( node.localName === 'iframe' ) {
            addIFrame(node);
        }
        var iframes = node.querySelectorAll('iframe');
        var i = iframes.length;
        while ( i-- ) {
            addIFrame(iframes[i]);
        }
        process();
    };

    return {
        add: add,
        addIFrame: addIFrame,
        iframesFromNode: iframesFromNode,
        process: process
    };
})();

/******************************************************************************/
/******************************************************************************/


// Gladly

var gladly;
var setUpGladly = function() {
    // Elements Gladly has processed.
    var elemsProcessed = [];

    var addProcessedNodes = function(nodes) {
        elemsProcessed = elemsProcessed.concat(nodes);
    }

    var getProcessedNodes = function() {
        return elemsProcessed;
    }

    // Set in contentscript-start.js.
    var isGladlyPartnerPage = vAPI.isGladlyPartnerPage;

    gladly = {
        addProcessedNodes: addProcessedNodes,
        getProcessedNodes: getProcessedNodes,
        isGladlyPartnerPage: isGladlyPartnerPage,
    };
};

// Cosmetic filters

(function() {
    if ( vAPI.skipCosmeticFiltering ) {
        // console.debug('Abort cosmetic filtering');
        return;
    }

    //var timer = window.performance || Date;
    //var tStart = timer.now();
    var queriedSelectors = {};
    var injectedSelectors = {};
    var lowGenericSelectors = [];
    var highGenerics = null;
    var contextNodes = [document];
    var nullArray = { push: function(){} };

    var retrieveGenericSelectors = function() {
        if ( lowGenericSelectors.length !== 0 || highGenerics === null ) {
            //console.log('µBlock> ABP cosmetic filters: retrieving CSS rules using %d selectors', lowGenericSelectors.length);
            // console.log('lowGenericSelectors', lowGenericSelectors);
            messager.send({
                    what: 'retrieveGenericCosmeticSelectors',
                    pageURL: window.location.href,
                    selectors: lowGenericSelectors,
                    firstSurvey: highGenerics === null
                },
                retrieveHandler
            );
            // https://github.com/chrisaljoudi/uBlock/issues/452
            retrieveHandler = nextRetrieveHandler;
        } else {
            nextRetrieveHandler(null);
        }
        lowGenericSelectors = [];
    };

    // https://github.com/chrisaljoudi/uBlock/issues/452
    // This needs to be executed *after* the response from our query is
    // received, not at `DOMContentLoaded` time, or else there is a good
    // likeliness to outrun contentscript-start.js, which may still be waiting
    // on a response from its own query.
    var firstRetrieveHandler = function(response) {
        // Wait to set up Gladly information until we're sure
        // contentscript-start.js is finished.
        setUpGladly();

        // https://github.com/chrisaljoudi/uBlock/issues/158
        // Ensure injected styles are enforced
        // rhill 2014-11-16: not sure this is needed anymore. Test case in
        //  above issue was fine without the line below..
        var selectors = vAPI.hideCosmeticFilters;
        // console.log('hideCosmeticFilters', selectors);
        if ( typeof selectors === 'object' ) {
            injectedSelectors = selectors;
            // If this is a Gladly page, don't hide ads.
            // Instead, modify them appropriately.
            if (gladly.isGladlyPartnerPage) {
                modifyAdsForGladly(Object.keys(selectors), numAds);
            }
            else {
                hideElements(Object.keys(selectors));
            }
        }
        // Add exception filters into injected filters collection, in order
        // to force them to be seen as "already injected".
        selectors = vAPI.donthideCosmeticFilters;
        if ( typeof selectors === 'object' ) {
            for ( var selector in selectors ) {
                if ( selectors.hasOwnProperty(selector) ) {
                    injectedSelectors[selector] = true;
                }
            }
        }
        // Flush dead code from memory
        firstRetrieveHandler = null;

        // These are sent only once
        var result = response && response.result;
        if ( result ) {
            if ( result.highGenerics ) {
                highGenerics = result.highGenerics;
            }
            if ( result.donthide ) {
                processLowGenerics(result.donthide, nullArray);
            }
        }

        nextRetrieveHandler(response);
    };

    var nextRetrieveHandler = function(response) {
        // https://github.com/gorhill/uMatrix/issues/144
        if ( response && response.shutdown ) {
            shutdownJobs.exec();
            return;
        }
        // console.log('nextRetrieveHandler');
        // console.log(response);

        //var tStart = timer.now();
        //console.debug('µBlock> contextNodes = %o', contextNodes);
        var result = response && response.result;
        var hideSelectors = [];
        if ( result && result.hide.length ) {
            // console.log('Selectors to hide: ', response.result.hide);
            processLowGenerics(result.hide, hideSelectors);
        }
        if ( highGenerics ) {
            if ( highGenerics.hideLowCount ) {
                processHighLowGenerics(highGenerics.hideLow, hideSelectors);
            }
            if ( highGenerics.hideMediumCount ) {
                processHighMediumGenerics(highGenerics.hideMedium, hideSelectors);
            }
            if ( highGenerics.hideHighCount ) {
                processHighHighGenericsAsync();
            }
        }
        // console.log('hideSelectors', hideSelectors);
        if ( hideSelectors.length !== 0 ) {
            // console.log('Hiding selectors!');
            addStyleTag(hideSelectors);
        }
        contextNodes.length = 0;
        //console.debug('%f: uBlock: CSS injection time', timer.now() - tStart);
    };

    var retrieveHandler = firstRetrieveHandler;

    // Ensure elements matching a set of selectors are visually removed
    // from the page, by:
    // - Modifying the style property on the elements themselves
    // - Injecting a style tag

    var addStyleTag = function(selectors) {
        var selectorStr = selectors.join(',\n');
        if (gladly.isGladlyPartnerPage) {
            numAds = modifyAdsForGladly(selectorStr, numAds);
        }
        else {
            hideElements(selectorStr);
            var style = document.createElement('style');
            // The linefeed before the style block is very important: do no remove!
            style.appendChild(document.createTextNode(selectorStr + '\n{display:none !important;}'));
            var parent = document.body || document.documentElement;
            if ( parent ) {
                parent.appendChild(style);
                vAPI.styles.push(style);
            }
        }
        messager.send({
            what: 'cosmeticFiltersInjected',
            type: 'cosmetic',
            hostname: window.location.hostname,
            selectors: selectors
        });
        //console.debug('µBlock> generic cosmetic filters: injecting %d CSS rules:', selectors.length, text);
    };

    // BEGIN TOOLTIP FUNCTIONS

    var goodblockTooltip = {
        tooltipId: 'goodblock-informational-tooltip',
    };

    goodblockTooltip.getDimensions = function() {
        return {
            'width': 140,
            'height': 76,
        }
    }

    goodblockTooltip.getTooltipTriangleDimensions = function() {
        return {
            'width': 20,
            'height': 12,
        }
    }

    goodblockTooltip.handleMouseover = function() {
        goodblockTooltip.clearHideTimers();
    }

    goodblockTooltip.handleMouseout = function() {
        goodblockTooltip.hide();
    }

    goodblockTooltip.addTooltipListeners = function(elem) {
        elem.addEventListener('mouseover', goodblockTooltip.handleMouseover);
        elem.addEventListener('mouseout', goodblockTooltip.handleMouseout);
    }

    goodblockTooltip.addTooltipButtonListener = function(elem) {
        elem.addEventListener('click', goodblockModal.show);
    }

    goodblockTooltip.create = function() {
        var tooltipId = this.tooltipId;
        var tooltipElem = document.createElement('div');
        tooltipElem.id = tooltipId;
        var dimensions = goodblockTooltip.getDimensions();
        var tooltipTriangleDims = goodblockTooltip.getTooltipTriangleDimensions();
        
        // Tooltip body.
        tooltipElem.style.setProperty('width', dimensions.width + 'px', 'important');
        tooltipElem.style.setProperty('height', dimensions.height + 'px', 'important');
        tooltipElem.style.setProperty('position', 'absolute', 'important');
        tooltipElem.style.setProperty('z-index', '16777271', 'important');
        tooltipElem.style.setProperty('background', '#FFF', 'important');
        tooltipElem.style.setProperty('border-radius', '2px', 'important');
        tooltipElem.style.setProperty('border', '1px solid #EFEFEF', 'important');
        tooltipElem.style.setProperty('padding', '4px', 'important');
        tooltipElem.style.setProperty('box-sizing', 'border-box', 'important');
        tooltipElem.style.setProperty('text-align', 'center', 'important');
        tooltipElem.style.setProperty('font-family', "'Helvetica Neue', Roboto, 'Segoe UI', Calibri, sans-serif", 'important');
        tooltipElem.style.setProperty('box-shadow', 'rgba(0, 0, 0, 0.0980392) 2px 4px 2px 2px', 'important');
        tooltipElem.style.setProperty('font-size', '13px', 'important');
        goodblockTooltip.addTooltipListeners(tooltipElem);
        // Tooltip content.
        tooltipElem.innerHTML = 'This ad is raising money for charity.';
        var tooltipButton = document.createElement('div');
        tooltipButton.innerHTML = 'Learn more'
        tooltipButton.style.setProperty('text-align', 'center', 'important');
        tooltipButton.style.setProperty('padding', '4px', 'important');
        tooltipButton.style.setProperty('background', '#1393C5', 'important');
        tooltipButton.style.setProperty('cursor', 'pointer', 'important')
        tooltipButton.style.setProperty('margin', '4px auto 0px auto', 'important');
        tooltipButton.style.setProperty('width', '70px', 'important');
        tooltipButton.style.setProperty('color', '#FFF', 'important');
        tooltipButton.style.setProperty('border-radius', '2px', 'important');
        goodblockTooltip.addTooltipButtonListener(tooltipButton);
        tooltipElem.appendChild(tooltipButton);
        // var tooltipContent = document.createElement('div');
        // Tooltip triangle.
        var tooltipTriangle = document.createElement('div');
        tooltipTriangle.style.setProperty('position', 'absolute', 'important');
        tooltipTriangle.style.setProperty('bottom', -(tooltipTriangleDims.height - 1) + 'px', 'important');
        tooltipTriangle.style.setProperty('left', 'calc(50% - ' + tooltipTriangleDims.height + 'px)', 'important');
        tooltipTriangle.style.setProperty('width', '0', 'important');
        tooltipTriangle.style.setProperty('height', '0', 'important');
        tooltipTriangle.style.setProperty('border-left', tooltipTriangleDims.width/2 + 'px solid transparent', 'important');
        tooltipTriangle.style.setProperty('border-right', tooltipTriangleDims.width/2 + 'px solid transparent', 'important');
        tooltipTriangle.style.setProperty('border-top', tooltipTriangleDims.height + 'px solid #FFF', 'important');
        tooltipElem.appendChild(tooltipTriangle);
        // Transitions.
        tooltipElem.style.setProperty('-webkit-transition', 'opacity 0.3s', 'important');
        tooltipElem.style.setProperty('-moz-transition', 'opacity 0.3s', 'important');
        tooltipElem.style.setProperty('transition', 'transform 0.3s, opacity 0.3s', 'important');
        document.body.appendChild(tooltipElem);
        // Start with the tooltip hidden.
        goodblockTooltip.addHideProperties();
        // Make sure the initial states are applied.
        // This is because we will transition immediately.
        window.getComputedStyle(tooltipElem).opacity;
        return tooltipElem;
    }

    goodblockTooltip.get = function() {
        var tooltipId = this.tooltipId;
        var tooltipElem = document.querySelector('#' + tooltipId);
        if (tooltipElem) {
            return tooltipElem;
        }
        else {
            return goodblockTooltip.create();
        }
    }

    goodblockTooltip.addHideProperties = function() {
        var tooltipElem = goodblockTooltip.get();
        tooltipElem.style.setProperty('-webkit-transform', 'scale(0.7)', 'important');
        tooltipElem.style.setProperty('-moz-transform', 'scale(0.7)', 'important');
        tooltipElem.style.setProperty('-ms-transform', 'scale(0.7)', 'important');
        tooltipElem.style.setProperty('transform', 'scale(0.7)', 'important');
        tooltipElem.style.setProperty('opacity', '0', 'important');
    }

    goodblockTooltip.hideNoTimeout = function() {
        var tooltipElem = goodblockTooltip.get();
        goodblockTooltip.addHideProperties();
        // Delay to hide because of animation.
        goodblockTooltip.tooltipHideTimeoutId = window.setTimeout(function() {
            tooltipElem.style.setProperty('left', '-9999px', 'important'); // Move offscreen.
        }, 300);
    }

    goodblockTooltip.hide = function() {
        goodblockTooltip.tooltipFadeTimeoutId = window.setTimeout(function() {
            goodblockTooltip.hideNoTimeout();
        }, 500);
    }

    // Clear any previous hide timeouts on the tooltip.
    goodblockTooltip.clearHideTimers = function() {
        if(typeof goodblockTooltip.tooltipFadeTimeoutId == "number") {
            window.clearTimeout(goodblockTooltip.tooltipFadeTimeoutId);
        }
        if(typeof goodblockTooltip.tooltipHideTimeoutId == "number") {
            window.clearTimeout(goodblockTooltip.tooltipHideTimeoutId);
        }
    }

    goodblockTooltip.show = function(targetElem) {
        goodblockTooltip.clearHideTimers();
        var tooltipElem = goodblockTooltip.get();
        // Move tooltip into position.
        var rect = targetElem.getBoundingClientRect(); // the coordinates of the target elem
        var tooltipDimensions = goodblockTooltip.getDimensions();
        var tooltipTriangleDims = goodblockTooltip.getTooltipTriangleDimensions();
        var adIconDimensions = getAdIconContainerDimensions();
        var topPos = rect.top - tooltipDimensions.height - tooltipTriangleDims.height;
        var leftPos = rect.left - tooltipDimensions.width/2 + adIconDimensions.width/2;
        tooltipElem.style.setProperty('top', topPos + 'px', 'important');
        tooltipElem.style.setProperty('left', leftPos + 'px', 'important');
        // Animate the appearance.
        tooltipElem.style.setProperty('-webkit-transform', 'scale(1)', 'important');
        tooltipElem.style.setProperty('-moz-transform', 'scale(1)', 'important');
        tooltipElem.style.setProperty('-ms-transform', 'scale(1)', 'important');
        tooltipElem.style.setProperty('transform', 'scale(1)', 'important');
        tooltipElem.style.setProperty('opacity', '0.99', 'important');
    }

    // END TOOLTIP FUNCTIONS

    // BEGIN MODAL FUNCTIONS

    var goodblockModal = {
        ids: {
            modal: 'goodblock-informational-modal',
            modalTint: 'goodblock-informational-modal-tint',
            modalImgHolder: 'goodblock-informational-modal-img-holder',
            modalImg: 'goodblock-informational-modal-img',
            modalTitle: 'goodblock-informational-modal-title',
            modalText: 'goodblock-informational-modal-text',
            vcAmountContainer: 'goodblock-informational-modal-vc-amount-container',
            impactContainer: 'goodblock-informational-modal-impact-conatainer',
            vcAmountText: 'goodblock-informational-modal-vc-amount-text',
            impactText: 'goodblock-informational-modal-impact-text',
            vcAmountImg: 'goodblock-informational-modal-vc-img',
            impactImg: 'goodblock-informational-modal-impact-img',
            'closeIcon': 'goodblock-informational-modal-close-icon',
        },
        style: {
            logoHeightPx: 60,
            logoWidthPx: 60,
            modal: {
                fontSize: '14px',
                fontWeight: '300',
                lineHeight: '100%',
                fontFamily: "'Helvetica Neue', Roboto, 'Segoe UI', Calibri, sans-serif",
                textFontSize: '13px',
                statsContainer: {
                    width: '300px',
                    height: '58px',
                },
                stats: {
                    width: '100px',
                    fontSize: '14px',
                    fontWeight: '500',
                    lineHeight: '100%',
                },
            }
        }
    }

    goodblockModal.addTintListeners = function(modalTintElem) {
        modalTintElem.addEventListener('click', function() {
            goodblockModal.hide();
        });
    }

    goodblockModal.createTint = function() {
        var tintElem = document.createElement('div');
        tintElem.id = goodblockModal['ids']['modalTint'];
        tintElem.style.setProperty('position', 'fixed', 'important');
        tintElem.style.setProperty('top', '0px', 'important');
        tintElem.style.setProperty('left', '-9999px', 'important'); // Start hidden.
        tintElem.style.setProperty('opacity', '0', 'important');
        tintElem.style.setProperty('height', '100%', 'important');
        tintElem.style.setProperty('width', '100%', 'important');
        tintElem.style.setProperty('z-index', '16777270', 'important');
        tintElem.style.setProperty('background', 'rgba(0,0,0, 0.7)', 'important');
        // Transitions.
        tintElem.style.setProperty('-webkit-transition', 'opacity 0.3s', 'important');
        tintElem.style.setProperty('-moz-transition', 'opacity 0.3s', 'important');
        tintElem.style.setProperty('transition', 'opacity 0.3s', 'important');
        document.body.appendChild(tintElem);
        goodblockModal.addTintListeners(tintElem);
        // Make sure the initial states are applied.
        // This is because we will transition immediately.
        window.getComputedStyle(tintElem).opacity;
        return tintElem;
    }

    goodblockModal.getTintElem = function() {
        // See if the modal tint exists.
        var modalId = goodblockModal['ids']['modalTint'];
        var modalTintElem = document.querySelector('#' + modalId);
        if (modalTintElem) {
            return modalTintElem;
        }
        else {
            return goodblockModal.createTint();
        }
    }

    goodblockModal.hideTint = function() {
        var modalTintElem = goodblockModal.getTintElem();
        modalTintElem.style.setProperty('opacity', '0', 'important');
        // Delay to hide the modal because of animation.
        setTimeout(function() {
            modalTintElem.style.setProperty('left', '-9999px', 'important');
        }, 300);
    }

    goodblockModal.showTint = function() {
        var modalTintElem = goodblockModal.getTintElem();
        modalTintElem.style.setProperty('left', '0px', 'important');
        modalTintElem.style.setProperty('opacity', '0.99', 'important');
    }

    goodblockModal.populate = function(response) {
        var modalElem = goodblockModal.get();
        var modalImgHolderId = goodblockModal['ids']['modalImgHolder'];
        var modalTitleId = goodblockModal['ids']['modalTitle'];
        var modalTextId = goodblockModal['ids']['modalText'];
        var logoImgId = goodblockModal['ids']['modalImg'];
        var vcContainerId = goodblockModal['ids']['vcAmountContainer'];
        var impactContainerId = goodblockModal['ids']['impactContainer'];
        var vcImgId = goodblockModal['ids']['vcAmountImg'];
        var impactImgId = goodblockModal['ids']['impactImg'];
        var vcAmountElemId = goodblockModal['ids']['vcAmountText'];
        var impactElemId = goodblockModal['ids']['impactText'];
        var closeIconId = goodblockModal['ids']['closeIcon'];
        // Add images if they don't already exist.
        var logoImg = document.getElementById(logoImgId);
        if (!logoImg) {
            var logoHolderElem = document.getElementById(modalImgHolderId);
            var img = document.createElement('img');
            img.id = logoImgId;
            img.src = response.imgPaths.logo;
            img.style.setProperty('height', goodblockModal.style.logoHeightPx + 'px', 'important');
            img.style.setProperty('width', goodblockModal.style.logoWidthPx + 'px', 'important');
            img.style.setProperty('margin', 'auto', 'important');
            logoHolderElem.appendChild(img);
        }
        var vcImg = document.getElementById(vcImgId);
        if (!vcImg) {
            var vcContainerElem = document.getElementById(vcContainerId);
            var img = document.createElement('img');
            img.id = vcImgId;
            img.src = response.imgPaths.heart;
            img.style.setProperty('width', '40px', 'important');
            img.style.setProperty('height', '35px', 'important');
            img.style.setProperty('margin', 'auto', 'important');
            var imgHolder = document.createElement('div');
            imgHolder.style.setProperty('height', '43px', 'important');
            imgHolder.appendChild(img);
            vcContainerElem.insertBefore(imgHolder, vcContainerElem.firstChild);
        }
        var impactImg = document.getElementById(impactImgId);
        if (!impactImg) {
            var impactContainerElem = document.getElementById(impactContainerId);
            var img = document.createElement('img');
            img.id = impactImgId;
            img.src = response.imgPaths.water;
            img.style.setProperty('width', '33px', 'important');
            img.style.setProperty('height', '40px', 'important');
            img.style.setProperty('margin', 'auto', 'important');
            var imgHolder = document.createElement('div');
            imgHolder.style.setProperty('height', '43px', 'important');
            imgHolder.appendChild(img);
            impactContainerElem.insertBefore(imgHolder, impactContainerElem.firstChild);
        }
        var closeIcon = document.getElementById(closeIconId);
        if (!closeIcon) {
            // Icon color: #C5C5C5
            var img = document.createElement('img');
            img.id = closeIconId;
            img.src = response.imgPaths.close;
            img.style.setProperty('position', 'absolute', 'important');
            img.style.setProperty('top', '5px', 'important');
            img.style.setProperty('right', '5px', 'important');
            img.style.setProperty('height', '13px', 'important');
            img.style.setProperty('width', '13px', 'important');
            img.style.setProperty('cursor', 'pointer', 'important');
            img.addEventListener('click', function() {
                goodblockModal.hide();
            });
            modalElem.appendChild(img);
        }
        // Populate text.
        document.getElementById(modalTitleId).innerHTML = response.text.title;
        document.getElementById(modalTextId).innerHTML = response.text.text;
        document.getElementById(vcAmountElemId).innerHTML = response.text.vcAmount;
        document.getElementById(impactElemId).innerHTML = response.text.impact;
    }

    goodblockModal.create = function() {
        var modalId = goodblockModal['ids']['modal'];
        var modalElem = document.createElement('div');
        modalElem.id = modalId;
        modalElem.style.setProperty('width', '450px', 'important');
        modalElem.style.setProperty('height', '290px', 'important');
        modalElem.style.setProperty('position', 'fixed', 'important');
        modalElem.style.setProperty('top', 'calc(45% - 145px)', 'important'); // Subtract half the height
        modalElem.style.setProperty('z-index', '16777271', 'important');
        modalElem.style.setProperty('background', '#FFF', 'important');
        modalElem.style.setProperty('border-radius', '5px', 'important');
        modalElem.style.setProperty('font-family', goodblockModal.style.modal.fontFamily, 'important');
        modalElem.style.setProperty('text-align', 'center', 'important');
        // Modal content.
        // Logo image
        var logoHolderElem = document.createElement('div');
        logoHolderElem.id = goodblockModal['ids']['modalImgHolder'];
        logoHolderElem.style.setProperty('height', goodblockModal.style.logoHeightPx + 'px', 'important');
        logoHolderElem.style.setProperty('margin-top', '20px', 'important');
        // Title
        var titleElem = document.createElement('div');
        titleElem.style.setProperty('color', '#4f4f4f', 'important');
        titleElem.style.setProperty('font-size', '30px', 'important');
        titleElem.style.setProperty('margin', '0px auto 20px auto', 'important');
        titleElem.id = goodblockModal['ids']['modalTitle'];
        titleElem.style.setProperty('font-weight', goodblockModal.style.modal.fontWeight, 'important');
        titleElem.style.setProperty('line-height', goodblockModal.style.modal.lineHeight, 'important');
        // Text
        var textElem = document.createElement('div');
        textElem.style.setProperty('width', '270px', 'important');
        textElem.style.setProperty('color', '#787878', 'important');
        textElem.style.setProperty('font-size', goodblockModal.style.modal.textFontSize, 'important');
        textElem.style.setProperty('margin', '10px auto', 'important');
        textElem.style.setProperty('font-family', goodblockModal.style.modal.fontFamily, 'important');
        textElem.style.setProperty('font-weight', goodblockModal.style.modal.fontWeight, 'important');
        textElem.style.setProperty('line-height', goodblockModal.style.modal.lineHeight, 'important');
        textElem.id = goodblockModal['ids']['modalText'];
        // Impact container
        var statsContainer = document.createElement('div');
        statsContainer.style.setProperty('width', goodblockModal.style.modal.statsContainer.width, 'important');
        statsContainer.style.setProperty('height', goodblockModal.style.modal.statsContainer.height, 'important');
        statsContainer.style.setProperty('margin', '20px auto 10px auto', 'important');
        statsContainer.style.setProperty('font-weight', goodblockModal.style.modal.stats.fontWeight, 'important');
        // VC amount
        var vcAmountContainer = document.createElement('div');
        vcAmountContainer.style.setProperty('display', 'inline-block', 'important');
        vcAmountContainer.style.setProperty('width', goodblockModal.style.modal.stats.width, 'important');
        vcAmountContainer.id = goodblockModal['ids']['vcAmountContainer'];
        var vcAmountTextElem = document.createElement('div');
        vcAmountTextElem.id = goodblockModal['ids']['vcAmountText'];
        vcAmountTextElem.style.setProperty('font-family', goodblockModal.style.modal.fontFamily, 'important');
        vcAmountTextElem.style.setProperty('font-size', goodblockModal.style.modal.stats.fontSize, 'important');
        vcAmountTextElem.style.setProperty('line-height', goodblockModal.style.modal.stats.lineHeight, 'important');
        vcAmountContainer.appendChild(vcAmountTextElem);
        statsContainer.appendChild(vcAmountContainer);
        // Impact
        var impactContainer = document.createElement('div');
        impactContainer.style.setProperty('display', 'inline-block', 'important');
        impactContainer.style.setProperty('width', goodblockModal.style.modal.stats.width, 'important');
        impactContainer.id = goodblockModal['ids']['impactContainer'];
        var impactTextElem = document.createElement('div');
        impactTextElem.id = goodblockModal['ids']['impactText'];
        impactTextElem.style.setProperty('font-family', goodblockModal.style.modal.fontFamily, 'important');
        impactTextElem.style.setProperty('font-size', goodblockModal.style.modal.stats.fontSize, 'important');
        impactTextElem.style.setProperty('line-height', goodblockModal.style.modal.stats.lineHeight, 'important');
        impactContainer.appendChild(impactTextElem);
        statsContainer.appendChild(impactContainer);
        // Append to overlay parent.
        modalElem.appendChild(logoHolderElem);
        modalElem.appendChild(titleElem);
        modalElem.appendChild(textElem);
        modalElem.appendChild(statsContainer);

        // Transitions.
        modalElem.style.setProperty('-webkit-transition', 'transform 0.3s, opacity 0.3s', 'important');
        modalElem.style.setProperty('-moz-transition', 'transform 0.3s, opacity 0.3s', 'important');
        modalElem.style.setProperty('transition', 'transform 0.3s, opacity 0.3s', 'important');
        document.body.appendChild(modalElem);
        // Start with the modal hidden.
        goodblockModal.addHideProperties(modalElem);
        // Make sure the initial states are applied.
        // This is because we will transition immediately.
        window.getComputedStyle(modalElem).opacity;
        return modalElem;
    }

    goodblockModal.get = function() {
        // See if the modal exists.
        var modalId = goodblockModal['ids']['modal'];
        var modalElem = document.querySelector('#' + modalId);
        if (modalElem) {
            return modalElem;
        }
        else {
            return goodblockModal.create();
        }
    }

    goodblockModal.show = function() {
        // Fetch data for the overlay.
        messager.send({
            what: 'retrieveGoodblockOverlayData'
        }, goodblockModal.populate);
        var modalElem = goodblockModal.get();
        // Move back to on screen.
        // Subtract half the width of the modal.
        modalElem.style.left = 'calc(50% - 225px)';
        modalElem.dataset.modalState = 'active';
        // Animate the appearance.
        modalElem.style.setProperty('-webkit-transform', 'scale(1)', 'important');
        modalElem.style.setProperty('-moz-transform', 'scale(1)', 'important');
        modalElem.style.setProperty('-ms-transform', 'scale(1)', 'important');
        modalElem.style.setProperty('transform', 'scale(1)', 'important');
        modalElem.style.setProperty('opacity', '0.99', 'important');

        console.log('modal elem', modalElem)

        // Show the modal background.
        goodblockModal.showTint();
        // Make sure the tooltip is hidden.
        goodblockTooltip.hideNoTimeout();
    }

    goodblockModal.addHideProperties = function(modalElem) {
        modalElem.dataset.modalState = 'inactive';
        modalElem.style.setProperty('-webkit-transform', 'scale(0.7)', 'important');
        modalElem.style.setProperty('-moz-transform', 'scale(0.7)', 'important');
        modalElem.style.setProperty('-ms-transform', 'scale(0.7)', 'important');
        modalElem.style.setProperty('transform', 'scale(0.7)', 'important');
        modalElem.style.setProperty('opacity', '0', 'important');
    }

    goodblockModal.hide = function() {
        var modalElem = goodblockModal.get();
        goodblockModal.addHideProperties(modalElem);
        // Delay to hide the modal because of animation.
        setTimeout(function() {
            modalElem.style.setProperty('left', '-9999px', 'important'); // Move offscreen.
        }, 300);
        // Hide the modal tint element.
        goodblockModal.hideTint();
    }

    goodblockModal.toggle = function() {
        var modalElem = goodblockModal.get();
        if (modalElem.dataset.modalState === 'active') {
            goodblockModal.hide();
        }
        else {
            goodblockModal.show();
        }
    }

    // END MODAL FUNCTIONS

    var adIconMouseoverHandler = function(event) {
        var elem = event.currentTarget;
        elem.style['background-color'] = 'rgba(0, 0, 0, 0.4)';
        goodblockTooltip.show(elem);
    }

    var adIconMouseoutHandler = function(event) {
        var elem = event.currentTarget;
        elem.style['background-color'] = 'rgba(0,0,0,0.2)';
        goodblockTooltip.hide();
    }

    var addAdIconListeners = function(elem) {
        elem.addEventListener('mouseover', adIconMouseoverHandler);
        elem.addEventListener('mouseout', adIconMouseoutHandler);
        elem.addEventListener('click', function() {
            goodblockTooltip.hide();
            goodblockModal.toggle();
        });
    }

    var getAdIconContainerDimensions = function() {
        return {
            'width': 16,
            'height': 16,
            'padding': 2,
        }
    }

    // BEGIN FUNCTIONS FOR ADDING GOODBLOCK ICON TO AD.


    var isElemHorizontallyAligned = function(elem) {
        var parentWidth = window.getComputedStyle(elem.parentNode).width;
        var elemStyle = window.getComputedStyle(elem);
        var isHorizontallyAligned = (
            parseFloat(parentWidth) === 
            (parseFloat(elemStyle.width) + parseFloat(elemStyle.marginLeft) + parseFloat(elemStyle.marginRight))
        );
        return isHorizontallyAligned;
    }

    // TODO: functions to support smart searching for visible ad unit.

    var cleanNodes = function(nodes) {
        console.log('all the nodes!!', nodes);
        return nodes;
    }

    // var isElemHorizontallyAlignedOffset = function(elem) {
    //     var elemLeftOffset = elem.offsetLeft;
    //     var elemRightOffset = elemLeftOffset + parseFloat(window.getComputedStyle(elem).width);
    //     var parentElem = elem.parentNode;
    //     var parentElemLeftOffset = parentElem.offsetLeft;
    //     var parentElemRightOffset = parentElemLeftOffset + parseFloat(window.getComputedStyle(parentElem).width);
    //     var isElemHorizAligned = ((parentElemLeftOffset + parentElemRightOffset) === (elemLeftOffset + elemRightOffset));
    //     console.log('isElemHorizAligned', isElemHorizAligned, elem);
    //     console.log(parentElemLeftOffset, elemLeftOffset, parentElemRightOffset, elemRightOffset);
    //     return isElemHorizAligned;
    // }

    // var isParentOf = function(parent, child) {
    //     while(child.parentNode) {
    //         if (child.parentNode == parent) {
    //             return true;
    //         }
    //         child = child.parentNode;
    //     }
    //     return false;
    // };

    // var isContainedByAny = function(parents, child) {
    //     for (var i = 0; i < parents.length; i++) {
    //         if (isParentOf(parents[i], child)) {
    //             return true;
    //         }
    //     }
    //     return false;
    // };

    // var noGoodblockIconInAncestors = function(elem) {
    //   while(elem.parentNode) {
    //       if (elem.parentNode.dataset && elem.parentNode.dataset.goodblockIcon) {
    //           return false;
    //       }
    //       elem = elem.parentNode;
    //   }
    //   return true;
    // };

    // // Takes elem, a DOM element.
    // // Returns an array of iframe elements found within elem.
    // var findIframes = function(elem) {
    //   if (elem.nodeName.toLowerCase() == 'iframe') {
    //     return [elem];
    //   }
    //   var toReturn = [];
    //   for (var i = 0; i < elem.childNodes.length; i++) {
    //     toReturn = toReturn.concat(findIframes(elem.childNodes[i]));
    //   }
    //   return toReturn;
    // };

    // var isSmallElem = function(elem) {
    //     var SMALL_PX_WIDTH_THRESHOLD = 30;
    //     var SMALL_PX_HEIGHT_THRESHOLD = 30;
    //     var AREA_PX_THRESHOLD = 7000;
    //     var elemStyle = window.getComputedStyle(elem);
    //     var elemWidthPx = parseFloat(elemStyle.width);
    //     var elemHeightPx = parseFloat(elemStyle.height);
    //     var elemAreaPx = elemWidthPx * elemHeightPx;
    //     return (
    //         elemWidthPx < SMALL_PX_WIDTH_THRESHOLD ||
    //         elemHeightPx < SMALL_PX_HEIGHT_THRESHOLD ||
    //         elemAreaPx < AREA_PX_THRESHOLD
    //     );
    // };

    var copyStyleBetweenElems = function(copyFromElem, copyToElem) {
        var copyFromElemStyle = window.getComputedStyle(copyFromElem, '');
        copyToElem.style.cssText = copyFromElemStyle.cssText;
        // The .cssText method will copy calculated values in 
        // place of 'auto', so we want to replace any 'auto' values.
        if (isElemHorizontallyAligned(copyFromElem)) {
            copyToElem.style.setProperty('margin-left', 'auto', 'important');
            copyToElem.style.setProperty('margin-right', 'auto', 'important');
        }
    }

    function insertAfter(newNode, referenceNode) {
        referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
    }

    var insertGoodblockElemOnAdElem = function(adElem, goodblockElem) {
        copyStyleBetweenElems(adElem, goodblockElem);
        var adElemStyle = window.getComputedStyle(adElem);
        goodblockElem.style.setProperty('opacity', '0.99', 'important');
        goodblockElem.style.setProperty('display', 'block', 'important');
        goodblockElem.style.setProperty('background-color', 'rgba(0,256,0,0.2)', 'important');
        goodblockElem.style.setProperty('text-align', 'left', 'important');
        switch (adElemStyle.position) {
            case 'fixed':
                goodblockElem.style.setProperty('position', 'fixed', 'important');
                break;
            case 'absolute':
                goodblockElem.style.setProperty('position', 'relative', 'important');
                break;
            default:
                 goodblockElem.style.setProperty('position', 'relative', 'important');
              if (adElemStyle.display === 'inline' || adElemStyle.display === 'inline-block') {
                    // Hack to handle possible white space around
                    // inline elements.
                    // var inlineElemGapPx = 4;
                    var inlineElemGapPx = 0;
                }
                else {
                    var inlineElemGapPx = 0;
                };
                var marginTopGoodblock = 'calc(-' 
                    + adElemStyle.height + ' - ' 
                    + adElemStyle.marginBottom + ' - ' 
                    + adElemStyle.paddingTop + ' - ' 
                    + adElemStyle.paddingBottom + ' - ' 
                    + inlineElemGapPx + 'px' + ')';
                goodblockElem.style.setProperty('margin-top', marginTopGoodblock, 'important');
                break;
        }
        // // TODO: To handle margin-auto inline elements.
        // if (
        //     (adElemStyle.display === 'inline' || adElemStyle.display === 'inline-block') && 
        //     (isElemHorizontallyAlignedOffset(adElem))
        // ) {
        //     var marginLeftGoodblock = 'calc(50% - (' + adElemStyle.width + ' / 2) + (' + adElemStyle.marginLeft + ' / 2))';
        //     goodblockElem.style.setProperty('margin-left', marginLeftGoodblock, 'important');
        //     goodblockElem.style.setProperty('margin-right', 'auto', 'important');
        // }
        insertAfter(goodblockElem, adElem);
    }

    // Takes a DOM element.
    // Returns null.
    // Adds an goodblockIcon to the corner of the elem.
    var addGoodblockIconToElem = function(elem, numAds) {
      // If the element already has an goodblockIcon, skip it.
      if (!elem.dataset.goodblockIcon) {
        console.log('Adding goodblockIcon to: ', elem);
        numAds += 1;
        var dimensions = getAdIconContainerDimensions();
        var ICON_HEIGHT_PX = dimensions.width;
        var ICON_WIDTH_PX = dimensions.height;
        var ICON_PADDING = dimensions.padding;
        // The ad icon container.
        var goodblockIconElem = document.createElement('div');
        // The ad icon image.
        var adIconElem = document.createElement('img');
        var iconUrl = vAPI.goodblockIconUrl;
        adIconElem.setAttribute('src', iconUrl);
        adIconElem.style.setProperty('width', ICON_WIDTH_PX + 'px', 'important');
        adIconElem.style.setProperty('background-color', 'rgba(0,0,0,0.2)', 'important');
        adIconElem.style.setProperty('border-radius', '50%', 'important');
        adIconElem.style.setProperty('z-index', '16777271', 'important');
        adIconElem.style.setProperty('padding', ICON_PADDING + 'px', 'important');
        goodblockIconElem.style.setProperty('position', 'relative', 'important');
        addAdIconListeners(adIconElem);
        // The ad icon image holder.
        var adIconElemHolder = document.createElement('div');
        adIconElemHolder.appendChild(adIconElem);
        adIconElemHolder.style.setProperty('cursor', 'pointer', 'important');
        adIconElemHolder.style.setProperty('position', 'absolute', 'important');
        adIconElemHolder.style.setProperty('bottom', '0px', 'important');
        adIconElemHolder.style.setProperty('right', '0px', 'important');
        adIconElemHolder.style.setProperty('pointer-events', 'all', 'important');
        adIconElemHolder.style.setProperty('height', (ICON_HEIGHT_PX + ICON_PADDING*2) + 'px', 'important');
        adIconElemHolder.style.setProperty('z-index', '16777271', 'important');

        goodblockIconElem.appendChild(adIconElemHolder);
        // Mark that we added an goodblockIcon.
        elem.dataset.goodblockIcon = 'true';

        insertGoodblockElemOnAdElem(elem, goodblockIconElem);
      }
      return numAds;
    }

    // Takes a DOM element that filters have targeted
    // as elements that hold an advertisement.
    // Returns an array of DOM elements that we believe will be
    // the containers for advertisements.
    var getAdContainersForNode = function(node) {
        return node;

        // TODO: smart searching for visible ad unit.
        // if (isSmallElem(node)) {
        //     return node.parentNode;
        // }
        // return node;

        // var elemsProcessed = gladly.getProcessedNodes();
        // // Get any iframes within this node.
        // var iframes = findIframes(node);

        // // If we found an iframe, it's probably the ad unit.
        // if (iframes.length > 0 ) {
        //     var adContainers = iframes.map(function(elem, i) {
        //         return elem.parentNode;      // Go up to parent of iframes
        //     }).filter(function(elem) {
        //         return (
        //             !isContainedByAny(elemsProcessed, elem) &&
        //             noGoodblockIconInAncestors(elem)
        //         );
        //     });
        // }
        // // If there isn't an iframe, return an array
        // // containing the input element.
        // else {
        //     return [node];
        // }
    };

    // Takes an array of DOM elements that filters have targeted
    // as elements that hold an advertisement.
    // Returns an array of DOM elements that we believe will be
    // the containers for advertisements.
    var getAdContainersForNodes = function(nodes) {
      var adContainers = [];
      nodes.forEach(function(elem, index, array) {
        adContainers = adContainers.concat(getAdContainersForNode(elem));
      });
      return adContainers;
    };

    // Takes an array of DOM elements.
    // Add goodblockIcons to all ad containers.
    var goodblockIconsEverywhere = function(nodes, numAds) {
      nodes = cleanNodes(nodes);
      gladly.addProcessedNodes(nodes);
      var adContainers = getAdContainersForNodes(nodes);
      adContainers.forEach(function(elem, i, array) {
        numAds = addGoodblockIconToElem(elem, numAds);
      });
      return numAds;
    };

    // Takes an array of selectors.
    var modifyAdsForGladly = function(selectors, numAds) {
        if ( selectors.length === 0 ) {
            return;
        }
        if ( document.body === null ) {
            return;
        }
        var elems = document.querySelectorAll(selectors);
        var i = elems.length;
        // Convert nodelist to array.
        var nodes = [];
        while ( i-- ) {
            var target = elems[i];
            nodes.push(target);
        }
        numAds = goodblockIconsEverywhere(nodes, numAds);
        if (numAds != 0) {
            messager.send({
               what: 'countNumAds',
               numAds: numAds
           });
        }
        return numAds;
    };
    // END FUNCTIONS FOR ADDING GOODBLOCK ICON TO AD.

    var hideElements = function(selectors) {
        // https://github.com/chrisaljoudi/uBlock/issues/207
        // Do not call querySelectorAll() using invalid CSS selectors
        if ( selectors.length === 0 ) {
            return;
        }
        if ( document.body === null ) {
            return;
        }
        // https://github.com/chrisaljoudi/uBlock/issues/158
        // Using CSSStyleDeclaration.setProperty is more reliable
        var elems = document.querySelectorAll(selectors);
        var i = elems.length;
        while ( i-- ) {
            elems[i].style.setProperty('display', 'none', 'important');
        }
    };

    // Extract and return the staged nodes which (may) match the selectors.

    var selectNodes = function(selector) {
        var targetNodes = [];
        var i = contextNodes.length;
        var node, nodeList, j;
        var doc = document;
        while ( i-- ) {
            node = contextNodes[i];
            if ( node === doc ) {
                return doc.querySelectorAll(selector);
            }
            targetNodes.push(node);
            nodeList = node.querySelectorAll(selector);
            j = nodeList.length;
            while ( j-- ) {
                targetNodes.push(nodeList[j]);
            }
        }
        return targetNodes;
    };

    // Low generics:
    // - [id]
    // - [class]

    var processLowGenerics = function(generics, out) {
        var i = generics.length;
        var selector;
        while ( i-- ) {
            selector = generics[i];
            // console.log('processLowGenerics selector', selector);
            // For normal ad hiding, don't process the element if we already have.
            // Gladly partner page elements need to be processed each time
            // because we're adding elements to the ad.
            if (!gladly.isGladlyPartnerPage) {
                if ( injectedSelectors.hasOwnProperty(selector) ) {
                    continue;
                }
            }
            injectedSelectors[selector] = true;
            out.push(selector);
        }
    };

    // High-low generics:
    // - [alt="..."]
    // - [title="..."]

    var processHighLowGenerics = function(generics, out) {
        var attrs = ['title', 'alt'];
        var attr, attrValue, nodeList, iNode, node;
        var selector;
        while ( attr = attrs.pop() ) {
            nodeList = selectNodes('[' + attr + ']');
            iNode = nodeList.length;
            while ( iNode-- ) {
                node = nodeList[iNode];
                attrValue = node.getAttribute(attr);
                if ( !attrValue ) { continue; }
                // Candidate 1 = generic form
                // If generic form is injected, no need to process the specific
                // form, as the generic will affect all related specific forms
                selector = '[' + attr + '="' + attrValue + '"]';
                if ( generics.hasOwnProperty(selector) ) {
                    if ( injectedSelectors.hasOwnProperty(selector) === false ) {
                        injectedSelectors[selector] = true;
                        out.push(selector);
                        continue;
                    }
                }
                // Candidate 2 = specific form
                selector = node.localName + selector;
                if ( generics.hasOwnProperty(selector) ) {
                    if ( injectedSelectors.hasOwnProperty(selector) === false ) {
                        injectedSelectors[selector] = true;
                        out.push(selector);
                    }
                }
            }
        }
    };

    // High-medium generics:
    // - [href^="http"]

    var processHighMediumGenerics = function(generics, out) {
        var nodeList = selectNodes('a[href^="http"]');
        var iNode = nodeList.length;
        var node, href, pos, hash, selectors, selector, iSelector;
        while ( iNode-- ) {
            node = nodeList[iNode];
            href = node.getAttribute('href');
            if ( !href ) { continue; }
            pos = href.indexOf('://');
            if ( pos === -1 ) { continue; }
            hash = href.slice(pos + 3, pos + 11);
            selectors = generics[hash];
            if ( selectors === undefined ) { continue; }
            iSelector = selectors.length;
            while ( iSelector-- ) {
                selector = selectors[iSelector];
                if ( injectedSelectors.hasOwnProperty(selector) === false ) {
                    injectedSelectors[selector] = true;
                    out.push(selector);
                }
            }
        }
    };

    // High-high generics are *very costly* to process, so we will coalesce
    // requests to process high-high generics into as few requests as possible.
    // The gain is *significant* on bloated pages.

    var processHighHighGenericsMisses = 8;
    var processHighHighGenericsTimer = null;

    var processHighHighGenerics = function() {
        processHighHighGenericsTimer = null;
        if ( highGenerics.hideHigh === '' ) {
            return;
        }
        if ( injectedSelectors.hasOwnProperty('{{highHighGenerics}}') ) {
            return;
        }
        //var tStart = timer.now();
        if ( document.querySelector(highGenerics.hideHigh) === null ) {
            //console.debug('%f: high-high generic test time', timer.now() - tStart);
            processHighHighGenericsMisses -= 1;
            // Too many misses for these nagging highly generic CSS rules,
            // so we will just skip them from now on.
            if ( processHighHighGenericsMisses === 0 ) {
                injectedSelectors['{{highHighGenerics}}'] = true;
                //console.debug('high-high generic: apparently not needed...');
            }
            return;
        }
        injectedSelectors['{{highHighGenerics}}'] = true;
        // We need to filter out possible exception cosmetic filters from
        // high-high generics selectors.
        var selectors = highGenerics.hideHigh.split(',\n');
        var i = selectors.length;
        var selector;
        while ( i-- ) {
            selector = selectors[i];
            if ( injectedSelectors.hasOwnProperty(selector) ) {
                selectors.splice(i, 1);
            } else {
                injectedSelectors[selector] = true;
            }
        }
        if ( selectors.length !== 0 ) {
            addStyleTag(selectors);
        }
    };

    var processHighHighGenericsAsync = function() {
        if ( processHighHighGenericsTimer !== null ) {
            clearTimeout(processHighHighGenericsTimer);
        }
        processHighHighGenericsTimer = setTimeout(processHighHighGenerics, 300);
    };

    // Extract all ids: these will be passed to the cosmetic filtering
    // engine, and in return we will obtain only the relevant CSS selectors.

    var idsFromNodeList = function(nodes) {
        if ( !nodes || !nodes.length ) {
            return;
        }
        var qq = queriedSelectors;
        var ll = lowGenericSelectors;
        var node, v;
        var i = nodes.length;
        while ( i-- ) {
            node = nodes[i];
            if ( node.nodeType !== 1 ) { continue; }
            // id
            v = nodes[i].id;
            if ( typeof v !== 'string' ) { continue; }
            v = v.trim();
            if ( v === '' ) { continue; }
            v = '#' + v;
            if ( qq.hasOwnProperty(v) ) { continue; }
            ll.push(v);
            qq[v] = true;
        }
    };

    // Extract all classes: these will be passed to the cosmetic filtering
    // engine, and in return we will obtain only the relevant CSS selectors.

    var classesFromNodeList = function(nodes) {
        if ( !nodes || !nodes.length ) {
            return;
        }
        var qq = queriedSelectors;
        var ll = lowGenericSelectors;
        var node, v, vv, j;
        var i = nodes.length;
        while ( i-- ) {
            node = nodes[i];
            vv = node.classList;
            if ( typeof vv !== 'object' ) { continue; }
            j = vv.length || 0;
            while ( j-- ) {
                v = vv[j];
                if ( typeof v !== 'string' ) { continue; }
                v = '.' + v;
                // If we're doing normal ad-hiding, and we've already
                // processed this class, skip it.
                if (gladly && !gladly.isGladlyPartnerPage) {
                    if ( qq.hasOwnProperty(v) ) {
                        continue;
                    }
                }
                ll.push(v);
                qq[v] = true;
            }
        }
    };

    // Start cosmetic filtering.

    idsFromNodeList(document.querySelectorAll('[id]'));
    classesFromNodeList(document.querySelectorAll('[class]'));
    retrieveGenericSelectors();

    //console.debug('%f: uBlock: survey time', timer.now() - tStart);

    // Below this point is the code which takes care to observe changes in
    // the page and to add if needed relevant CSS rules as a result of the
    // changes.

    // Observe changes in the DOM only if...
    // - there is a document.body
    // - there is at least one `script` tag
    if ( !document.body || !document.querySelector('script') ) {
        return;
    }

    // https://github.com/chrisaljoudi/uBlock/issues/618
    // Following is to observe dynamically added iframes:
    // - On Firefox, the iframes fails to fire a `load` event

    var ignoreTags = {
        'link': true,
        'script': true,
        'style': true
    };

    // Added node lists will be cumulated here before being processed
    var addedNodeLists = [];
    var addedNodeListsTimer = null;
    var collapser = uBlockCollapser;

    var treeMutationObservedHandler = function() {
        var nodeList, iNode, node;
        while ( nodeList = addedNodeLists.pop() ) {
            iNode = nodeList.length;
            while ( iNode-- ) {
                node = nodeList[iNode];
                if ( node.nodeType !== 1 ) {
                    continue;
                }
                if ( ignoreTags.hasOwnProperty(node.localName) ) {
                    continue;
                }
                contextNodes.push(node);
                collapser.iframesFromNode(node);
            }
        }
        addedNodeListsTimer = null;
        if ( contextNodes.length !== 0 ) {
            // console.log('Filtering page after tree mutation change.');
            idsFromNodeList(selectNodes('[id]'));
            classesFromNodeList(selectNodes('[class]'));
            retrieveGenericSelectors();
            messager.send({ what: 'cosmeticFiltersActivated' });
        }
    };

    // https://github.com/chrisaljoudi/uBlock/issues/205
    // Do not handle added node directly from within mutation observer.
    var treeMutationObservedHandlerAsync = function(mutations) {
        // console.log('Tree mutation change.');
        // console.log('Mutation added nodes:', mutations);
        var iMutation = mutations.length;
        var nodeList;
        while ( iMutation-- ) {
            nodeList = mutations[iMutation].addedNodes;
            if ( nodeList.length !== 0 ) {
                addedNodeLists.push(nodeList);
            }
        }
        // console.log('Mutation; added node lists', addedNodeLists);
        if ( addedNodeListsTimer === null ) {
            // I arbitrarily chose 100 ms for now:
            // I have to compromise between the overhead of processing too few
            // nodes too often and the delay of many nodes less often.
            addedNodeListsTimer = setTimeout(treeMutationObservedHandler, 100);
        }
    };

    // https://github.com/chrisaljoudi/httpswitchboard/issues/176
    var treeObserver = new MutationObserver(treeMutationObservedHandlerAsync);
    treeObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    // https://github.com/gorhill/uMatrix/issues/144
    shutdownJobs.add(function() {
        // If this is a Gladly partner page, don't shut down the
        // mutation observer. We use it to watch for new nodes,
        // because we can't listen for blocked requests when we're
        // not filtering requests.
        if (!gladly.isGladlyPartnerPage) {
            treeObserver.disconnect();
            if ( addedNodeListsTimer !== null ) {
                clearTimeout(addedNodeListsTimer);
            }
        }
    });
})();

/******************************************************************************/
/******************************************************************************/

// Permanent

// Listener to collapse blocked resources.
// - Future requests not blocked yet
// - Elements dynamically added to the page
// - Elements which resource URL changes

(function() {
    var onResourceFailed = function(ev) {
        //console.debug('onResourceFailed(%o)', ev);
        uBlockCollapser.add(ev.target);
        uBlockCollapser.process();
    };
    document.addEventListener('error', onResourceFailed, true);

    // https://github.com/gorhill/uMatrix/issues/144
    shutdownJobs.add(function() {
        document.removeEventListener('error', onResourceFailed, true);
    });
})();

/******************************************************************************/
/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/7

// Executed only once

(function() {
    var collapser = uBlockCollapser;
    var elems, i, elem;

    elems = document.querySelectorAll('img, embed, object');
    i = elems.length;
    while ( i-- ) {
        collapser.add(elems[i]);
    }

    elems = document.querySelectorAll('iframe');
    i = elems.length;
    while ( i-- ) {
        collapser.addIFrame(elems[i]);
    }
    collapser.process(0);
})();

/******************************************************************************/
/******************************************************************************/

// To send mouse coordinates to context menu handler, as the chrome API fails
// to provide the mouse position to context menu listeners.
// This could be inserted in its own content script, but it's so simple that
// I feel it's not worth the overhead.

// Ref.: https://developer.mozilla.org/en-US/docs/Web/Events/contextmenu

(function() {
    if ( window !== window.top ) {
        return;
    }
    var onContextMenu = function(ev) {
        messager.send({
            what: 'contextMenuEvent',
            clientX: ev.clientX,
            clientY: ev.clientY
        });
    };

    window.addEventListener('contextmenu', onContextMenu, true);

    // https://github.com/gorhill/uMatrix/issues/144
    shutdownJobs.add(function() {
        document.removeEventListener('contextmenu', onContextMenu, true);
    });
})();

/******************************************************************************/
/******************************************************************************/

})();

/******************************************************************************/
