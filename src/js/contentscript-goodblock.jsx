console.log('Goodblock content script.');

/******************************************************************************/
/******************************************************************************/

var React = require('react/addons');
var GoodblockDataStore = require('./stores/GoodblockDataStore.jsx');
var GoodblockDataActions = require('./actions/GoodblockDataActions.jsx');
var GoodblockRootElem = require('./components/GoodblockRootElem.jsx');

/******************************************************************************/
/******************************************************************************/

// Set up the React app.

var reactBaseElemId = 'goodblock-react-base';

// Create the Goodblock app base element and return it.
var createBaseElem = function() {
	var reactBaseElem = document.createElement('div');
	reactBaseElem.id = reactBaseElemId;
	reactBaseElem.dataset.goodblockInitialized = 'true';
	document.body.appendChild(reactBaseElem);
	return reactBaseElem;
}

// Update the Goodblock app elements, creating them if they don't exist.
var initGoodblock = function() {
	var baseElem = document.querySelector('#' + reactBaseElemId);
	// If our app base element doesn't exist, let's create it.
	if (!baseElem) {
		baseElem = createBaseElem();
	}
	React.render(<GoodblockRootElem />, baseElem);
}

initGoodblock();

/******************************************************************************/
/******************************************************************************/

// On load, fetch Goodblock image URLs from the extension.
GoodblockDataActions.fetchImgUrls();
GoodblockDataActions.updateVisibility();

/******************************************************************************/
/******************************************************************************/
