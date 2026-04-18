// React entry point. Mounts <App /> into #root.

const React = require('react');
const ReactDOM = require('react-dom/client');
const { App } = require('./App');

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));
