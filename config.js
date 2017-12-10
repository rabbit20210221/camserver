const path = require('path');

function defineConstant(obj, name, value) {
	Object.defineProperty(obj, name, {
		value: value,
		configurable: false,
		writable: false,
		enumerable: true
	});
}

defineConstant(module.exports, 'WWW_ROOT', 'www');
defineConstant(module.exports, 'WEBM_CACHE', 'webm_live');
defineConstant(module.exports, 'TLS_SERVER_CERT', path.join('certs', 'server.pem'));
defineConstant(module.exports, 'TLS_SERVER_KEY', path.join('certs', 'server.key'));
defineConstant(module.exports, 'TLS_CA_CERT', path.join('certs', 'ca.pem'));
