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
            // Gladly edited.
            // style.appendChild(document.createTextNode(selectorStr + '\n{display:none !important;}'));
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

var gladly = (function() {
  // Elements Gladly has processed.
  var elemsProcessed = [];

  var addProcessedNodes = function(nodes) {
    elemsProcessed = elemsProcessed.concat(nodes);
  }

  var getProcessedNodes = function() {
    return elemsProcessed;
  }

  return {
    addProcessedNodes: addProcessedNodes,
    getProcessedNodes: getProcessedNodes,
  };
})();

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
        // https://github.com/chrisaljoudi/uBlock/issues/158
        // Ensure injected styles are enforced
        // rhill 2014-11-16: not sure this is needed anymore. Test case in
        //  above issue was fine without the line below..
        var selectors = vAPI.hideCosmeticFilters;
        // console.log('hideCosmeticFilters', selectors);
        if ( typeof selectors === 'object' ) {
            injectedSelectors = selectors;
            hideElements(Object.keys(selectors));
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
        hideElements(selectorStr);
        // var style = document.createElement('style');
        // // The linefeed before the style block is very important: do no remove!
        // style.appendChild(document.createTextNode(selectorStr + '\n{display:none !important;}'));
        // var parent = document.body || document.documentElement;
        // if ( parent ) {
        //     parent.appendChild(style);
        //     vAPI.styles.push(style);
        // }
        messager.send({
            what: 'cosmeticFiltersInjected',
            type: 'cosmetic',
            hostname: window.location.hostname,
            selectors: selectors
        });
        //console.debug('µBlock> generic cosmetic filters: injecting %d CSS rules:', selectors.length, text);
    };

    // var getElementTreeXPath = function(element) {
    //     var paths = [];
    //     // Use nodeName (instead of localName) so namespace prefix is included (if any).
    //     for (; element && element.nodeType == 1; element = element.parentNode)
    //     {
    //         var index = 0;
    //         for (var sibling = element.previousSibling; sibling; sibling = sibling.previousSibling) {
    //             // Ignore document type declaration.
    //             if (sibling.nodeType == Node.DOCUMENT_TYPE_NODE)
    //                 continue;
    //             if (sibling.nodeName == element.nodeName)
    //                 ++index;
    //         }
    //         var tagName = element.nodeName.toLowerCase();
    //         var pathIndex = (index ? "[" + (index+1) + "]" : "");
    //         paths.splice(0, 0, tagName + pathIndex);
    //     }
    //     return paths.length ? "/" + paths.join("/") : null;
    // };

    var isParentOf = function(parent, child) {
        while(child.parentNode) {
            if (child.parentNode == parent) {
                return true;
            }
            child = child.parentNode;
        }
        return false;
    }

    var isContainedByAny = function(parents, child) {
        for (var i = 0; i < parents.length; i++) {
            if (isParentOf(parents[i], child)) {
                return true;
            }
        }
        return false;
    }

    var noElephantInAncestors = function(elem) {
      while(elem.parentNode) {
          if (elem.parentNode.dataset && elem.parentNode.dataset.elephant) {
              return false;
          }
          elem = elem.parentNode;
      }
      return true;
    }

    // Takes elem, a DOM element.
    // Returns an array of iframe elements found within elem.
    var findIframes = function(elem) {
      if (elem.nodeName.toLowerCase() == 'iframe') {
        return [elem];
      }
      var toReturn = [];
      for (var i = 0; i < elem.childNodes.length; i++) {
        toReturn = toReturn.concat(findIframes(elem.childNodes[i]));
      }
      return toReturn;
    }

    // Takes a DOM element.
    // Returns null.
    // Adds an elephant to the corner of the elem.
    var addElephantToElem = function(elem) {
      // If the element already has an elephant, skip it.
      if (!elem.dataset.elephant) {
        // console.log('Adding elephant to: ', elem);
        // elem.style.position = 'relative';
        var elephantElem = document.createElement('div');
        elephantElem.setAttribute('style', 'margin-top: -48px; opacity: 0.99; text-align:left;');
        elephantElem.innerHTML = '<img style="width: 50px; z-index: 1000000" src="http://tabforacause-west.s3.amazonaws.com/static-1/img/sad-elephant.png">';
        elem.dataset.elephant = "true";
        for (var i = 0; i < elem.childNodes.length; i++) {
          if (elem.childNodes[i].style && elem.childNodes[i].clientWidth) {
            elephantElem.style['margin-left'] = elem.childNodes[i].style['margin-left'];
            elephantElem.style['margin-right'] = elem.childNodes[i].style['margin-right'];

            // TODO: figure out how to copy width here!
            elephantElem.style.width = elem.childNodes[i].clientWidth;
          }
        }
        elem.appendChild(elephantElem);
      }
    }

    // Takes a DOM element that filters have targeted
    // as elements that hold an advertisement.
    // Returns an array of DOM elements that we believe will be
    // the containers for advertisements.
    var getAdContainersForNode = function(node) {
      var elemsProcessed = gladly.getProcessedNodes();
      // Get any iframes within this node.
      var iframes = findIframes(node);

      // If we found an iframe, it's probably the ad unit.
      if (iframes.length > 0 ) {
        var adContainers = iframes.map(function(elem, i) {
          return elem.parentNode;      // Go up to parent of iframes
        }).filter(function(elem) {
          return (
            !isContainedByAny(elemsProcessed, elem) &&
            noElephantInAncestors(elem)
          );
        });
      }
      // If there isn't an iframe, return an array
      // containing the input element.
      else {
        return [node];
      }
      return adContainers;
    }

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
    }

    // Takes an array of DOM elements.
    // Add elephants to all ad containers.
    var elephantsEverywhere = function(nodes) {
      console.log('Considering adding elephants to these nodes:', nodes);
      gladly.addProcessedNodes(nodes);
      var adContainers = getAdContainersForNodes(nodes);
      adContainers.forEach(function(elem, i, array) {
        addElephantToElem(elem);
      });
    }

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
        var nodes = [];
        while ( i-- ) {
            // Measure the element. If it takes up room, replace it. Otherwise, get rid of it.
            var target = elems[i];
            // Just for dev, to make sure hidden divs (where we blocked the ad)
            // are shown.
            // var targetDisplayAttr = window.getComputedStyle(target).getPropertyValue('display');
            // if (targetDisplayAttr == 'none') {
            //   target.style.setProperty('display', 'inline-block', 'important');
            // }
            // elems[i].style.setProperty('display', 'none', 'important');
            nodes.push(target);
            // makeObserver().observe(target, {
            //   subtree: true,
            //   childList: true
            // });
        }
        elephantsEverywhere(nodes);
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
            // Don't process the element if we already have.
            if ( injectedSelectors.hasOwnProperty(selector) ) {
                // console.log('processLowGenerics already found', selector);
                continue;
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
                if ( qq.hasOwnProperty(v) ) { continue; }
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
        // Gladly edited: don't shut down the mutation observer.
        // We use it to watch for new nodes since we can't listen
        // for blocked requests when we're not filtering ad requests.

        // treeObserver.disconnect();
        // if ( addedNodeListsTimer !== null ) {
        //     clearTimeout(addedNodeListsTimer);
        // }
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
