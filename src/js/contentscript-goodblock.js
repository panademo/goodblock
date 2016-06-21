// console.log('Goodblock content script.');

/******************************************************************************/
/******************************************************************************/

var baseElemId = 'goodblock-iframe-base';
var goodblockIframeId = 'goodblock-iframe';

var createGbScript = function() {
	var script = document.createElement('script');
	script.id = baseElemId;
	script.src = process.env.GOODBLOCK_SCRIPT_SRC;
	script.async = 'async';
	script.dataset.goodblockContentScriptNum = 0;
	document.getElementsByTagName('head')[0].appendChild(script);
	return script;
}

var destroyGbScript = function(scriptElement) {
	if(scriptElement){
		document.getElementsByTagName('head')[0].removeChild(scriptElement);
	}
}

// Remove elements created by Goodblock.
var destroyGbElems = function() {
	var gbIframe = document.querySelector('#' + goodblockIframeId);
	if(gbIframe){
		document.getElementsByTagName('body')[0].removeChild(gbIframe);
	}
}

// Create the Goodblock script, destroying the existing one if it
// exists.
var createGbScriptIdempotent = function() {
	var baseElem = document.querySelector('#' + baseElemId);

	// Destroy the existing elements.
	if (baseElem) {
		destroyGbScript(baseElem);
		destroyGbElems();
	}

	baseElem = createGbScript();
	return baseElem;
}

// Update the Goodblock app elements, creating them if they don't exist.
var initGoodblock = function() {

	// Make sure our base elem exists.
	var baseElem = createGbScriptIdempotent();
}

// When this content script executes, there are two possibilities:
//   (1) This is the first time the content script has run in the
//		 current page, like when the user navigates to a new web
//		 page or when the user installs the extension for the first
//		 time.
//	 (2) This is the second or greater time the content script has
//	     has run in the current page. This can happen when the extension
//		 updates, when the user manually reloads the extension, or if
//		 the user uninstalls and reinstalls without reloading a web page.
initGoodblock();

/******************************************************************************/
/******************************************************************************/
