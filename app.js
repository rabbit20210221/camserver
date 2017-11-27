const http = require('http');
const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const assert = require('assert');
const crypto = require('crypto');
const stream = require('stream');
const url = require('url');
const path = require('path');

function rewriteUrl(buffer, clientReq, options) {
	var procotol = clientReq.client.ssl ? 'https://' : 'http://';
	var b =  buffer.toString('utf-8')
		.replace(/[\'\"]http(s|)\:\/\/(.*?)[\'\"]/gi, '"' + procotol + 'localhost:3000/proxy/$2"') // "http://external.host/path/file.ext" --> "http://localhost:3000/external.host/path/file.ext"
		.replace(/[\'\"]\/\/(.*?)[\'\"]/gi, '"' + procotol + 'localhost:3000/proxy/$1"') // "//external.host/path/file.ext" --> "http://localhost:3000/external.host/path/file.ext"
		.replace(/[\'\"]\/([a-zA-Z0-9].*?)[\'\"]/gi, '"' + procotol + 'localhost:3000/proxy/' + options.hostname + '/$1"') // "/path/file.ext" --> "http://localhost/external.host/path/file.ext"
		//.replace(/[\'\"]http\:\/\/(.*?)[\'\"]/gi, '"http://localhost:3000/$1"')
		//.replace(/[\'\"]\/(.*?)[\'\"]/gi, '"http://localhost:3000/' + options.hostname + '/$1"');
	return b;
}

function getPropertyNoCase(object, propertyName) {
	for (p in object) {
		if (object.hasOwnProperty(p) && p.toLowerCase() === propertyName.toLowerCase())
			return object[p];
	}
	return null;
}

function setIncomingHeaders(proxyRes) {
	var headers = {}
	for (header in proxyRes.headers) {
		if (proxyRes.headers.hasOwnProperty(header)) {
			switch(header.toLowerCase()) {
				case 'content-encoding':
				case 'content-length':
				case 'transfer-encoding':
					break; // don't set yet
				default:
					headers[header] = proxyRes.headers[header];
			}
		}
	}
	headers['access-control-allow-origin'] = '*';
	return headers;	
}

function setOutgoingHeaders(clientReq) {
	var headers = {}
	for (header in clientReq.headers) {
		if (clientReq.headers.hasOwnProperty(header)) {
			switch(header.toLowerCase()) {
				case 'accept-encoding':
				case 'conkie':
				case 'user-agent':
					headers[header] = clientReq.headers[header];
			}
		}
	}
	return headers;	
}

function handleProxyResponse(clientReq, clientRes, proxyRes, options) {
	console.log('STATUS: ' + proxyRes.statusCode + ' ' + options.path);
	console.log('HEADERS: ' + JSON.stringify(proxyRes.headers));
	assert(!proxyRes.objectId);
	proxyRes.objectId = crypto.randomFillSync(Buffer.alloc(8)).toString('hex');
	var clientAcceptEncoding = (getPropertyNoCase(clientReq.headers, 'accept-encoding') || '').toLowerCase();
	var proxyResponseEncoding = (getPropertyNoCase(proxyRes.headers, 'content-encoding') || '').toLowerCase();
	var proxyResponseContentType = (getPropertyNoCase(proxyRes.headers, 'content-type') || '').toLowerCase();
	var clientResponseHeaders = setIncomingHeaders(proxyRes);
	if (proxyResponseContentType.startsWith('text/html')) {
		streamFromProxy = new stream.PassThrough();
		// If this is html then need to decompress first to rewrite urls in the content
		if (proxyResponseEncoding === 'gzip' || proxyResponseEncoding === 'deflate')
			proxyRes.pipe(zlib.createUnzip()).pipe(streamFromProxy);
		else
			proxyRes.pipe(streamFromProxy);
		var chunks = [];
		streamFromProxy.on('data', function(chunk) {
			chunks.push(chunk);
		}).on('end', function() {
			console.log('[' + proxyRes.objectId + '] end chunk # ' + chunks.length);
			var completeBuffer = Buffer.concat(chunks);
			var streamToClient = new stream.PassThrough();
			// If client browser accepts compressed data then compress
			if (clientAcceptEncoding.includes('gzip')) {
				streamToClient = zlib.createGzip();
				clientResponseHeaders['content-encoding'] = 'gzip';
			}
			else if (clientAcceptEncoding.includes('deflate')) {
				streamToClient = zlib.createDeflate();
				clientResponseHeaders['content-encoding'] = 'deflate';
			}
			clientRes.writeHead(proxyRes.statusCode, clientResponseHeaders); // headers are not compressed
			streamToClient.pipe(clientRes);
			streamToClient.write(rewriteUrl(completeBuffer, clientReq, options));
			streamToClient.end();
		}).on('error', function() {
			clientRes.end();
		});
	}
	else {
		// If proxy response is not compressed and client browser accepts compressed data
		// then compress it
		var streamToClient = new stream.PassThrough();
		if (proxyResponseEncoding !== 'gzip' && proxyResponseEncoding !== 'deflate') {
			if (clientAcceptEncoding.includes('gzip')) {
				streamToClient = zlib.createGzip();
				clientResponseHeaders['content-encoding'] = 'gzip';
			}
			else if (clientAcceptEncoding.includes('deflate')) {
				streamToClient = zlib.createDeflate();
				clientResponseHeaders['content-encoding'] = 'deflate';
			}
		}
		else if (proxyResponseEncoding.length > 0)
			clientResponseHeaders['content-encoding'] = proxyResponseEncoding;
		clientRes.writeHead(proxyRes.statusCode, clientResponseHeaders); // headers are not compressed
		proxyRes.pipe(streamToClient).pipe(clientRes);
	}
}

function getOptions(clientReq, callback) {
	const options = {
		port: 80,
		path: '/',
		method: 'GET',
		headers: setOutgoingHeaders(clientReq)
	};
	var seps = clientReq.url.split('/') || [];
	if (seps.length === 0)
		return callback("error", null);
	if (seps[0].length === 0)
		seps = seps.length > 1 ? seps.slice(1) : [];
	var tag = seps[0];
	seps = seps.length > 1 ? seps.slice(1) : [];
	if (tag === 'proxy') {
		options.proxy = true;
		if (seps[0].startsWith('https://')) {
			options.proxyTls = true;
			seps[0] = seps[0].substring('https://'.length);
		}
		else if (seps[0].startsWith('http://'))
			seps[0] = seps[0].substring('http://'.length);
		var hostname = seps[0].split(':');
		options.hostname = hostname[0];
		if (hostname.length > 1)
			options.port = parseInt(hostname[1]);
		if (seps.length > 1)
			options.path += seps.slice(1).join('/');
		options.method = clientReq.method;
		return callback(null, options);
	}
	else if (tag === 'api') {
		options.api = true;
		options.resourceType = seps[0];
		options.resource = seps[1];
		options.action = seps[2];
		clientReq.setEncoding('utf8');
		var rawData = '';
		clientReq.on('data', function(chunk) {
			rawData += chunk; 
		});
		clientReq.on('end', function() {
			try {
				options.body = JSON.parse(rawData);
			} catch (e) {
				console.error(e.message);
			}
			return callback(null, options);
		});
	}
	else
		return callback(null, options);
}

function serveStaticFiles(clientReq, clientRes, options) {
	// parse URL
	const parsedUrl = url.parse(clientReq.url);
	// extract URL path
	let pathname = `.${parsedUrl.pathname}`;
	// based on the URL path, extract the file extention. e.g. .js, .doc, ...
	const ext = path.parse(pathname).ext;
	// maps file extention to MIME typere
	const map = {
		'.ico': 'image/x-icon',
		'.html': 'text/html',
		'.js': 'text/javascript',
		'.json': 'application/json',
		'.css': 'text/css',
		'.png': 'image/png',
		'.jpg': 'image/jpeg',
		'.wav': 'audio/wav',
		'.mp3': 'audio/mpeg',
		'.svg': 'image/svg+xml',
		'.pdf': 'application/pdf',
		'.doc': 'application/msword'
	};

	fs.exists(pathname, function (exist) {
		if(!exist) {
			// if the file is not found, return 404
			clientRes.statusCode = 404;
			clientRes.end(`File ${pathname} not found!`);
			return;
		}

		// if is a directory search for index file matching the extention
		if (fs.statSync(pathname).isDirectory()) pathname += '/index' + ext;

		// read file from file system
		fs.readFile(pathname, function(err, data){
			if(err){
				clientRes.statusCode = 500;
				clientRes.end(`Error getting the file: ${err}.`);
			} else {
				// if the file is found, set Content-type and send data
				clientRes.setHeader('Content-type', map[ext] || 'text/plain' );
				clientRes.end(data);
			}
		});
	});
}

class EsCamG02 {
	constructor(name, hostname, port, username, password) {
		this.name = name;
		this.options = {
			method: 'GET',
			hostname: hostname,
			port: port,
			auth: username + ':' + password
		}
		this.optionsRight = Object.assign({}, this.options);
		this.optionsLeft = Object.assign({}, this.options);
		this.optionsUp = Object.assign({}, this.options);
		this.optionsDown = Object.assign({}, this.options);
		this.optionsRight.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=right';
		this.optionsLeft.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=left';
		this.optionsUp.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=up';
		this.optionsDown.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=down';
	}
	
	perform(reqBody, callback) {
		var options;
		switch (reqBody.action) {
			case 'step':
				switch (reqBody.direction) {
					case 'right': options = this.optionsRight; break;
					case 'left': options = this.optionsLeft; break;
					case 'up': options = this.optionsUp; break;
					case 'down': options = this.optionsDown; break;
				}
				break;
		}
		if (options) {
			var req = http.request(options, function(res) {
				callback(null, res);
			});
			req.on('error', (e) => {
				console.error('EsCamG02(' + this.name + ') error:' + e.message);
				callback(e, null);
			});
			req.end();
		}
		else
			callback('unsupported action', null);
	}
}

const cameras = [
	new EsCamG02('front', '192.168.1.4', 80, 'admin', 'admin')
];

const tlsOptions = {
	key: fs.readFileSync('c:/openssl_ca/server.key'),
	cert: fs.readFileSync('c:/openssl_ca/server.pem'),
	ca: fs.readFileSync('c:/openssl_ca/ca.pem'),
	requestCert: true,
	rejectUnauthorized: true
};


var httpServer = https.createServer(tlsOptions);
//var httpServer = http.createServer();

httpServer.on('request', function(clientReq, clientRes) {
	getOptions(clientReq, function(err, options) {
		if (!options)
			return clientRes.end();
		if (options.proxy) {
			// do proxy
			var proxyReq, proxyTls = options.proxyTls;
			delete options.proxyTls;
			delete options.proxy;
			if (proxyTls)
				proxyReq = https.request(options, function(proxyRes) {
					handleProxyResponse(clientReq, clientRes, proxyRes, options);
				});
			else
				proxyReq = http.request(options, function(proxyRes) {
					handleProxyResponse(clientReq, clientRes, proxyRes, options);
				});
			proxyReq.on('error', (e) => {
				console.error('problem with request: ' + e.message);
				clientRes.end();
			});
			// write data to request body
			//proxyReq.write(postData);
			proxyReq.end();
		}
		else if (options.api) {
			// api - cameras only for now
			var camera = cameras.find(function (camera) {
				return (this.resource === camera.name);
			}, options);
			if (camera) {
				camera.perform(options.body, function (error, cameraRes) {
					if (cameraRes) {
						clientRes.writeHead(cameraRes.statusCode, { 'content-type': 'text/plain'});
						cameraRes.pipe(clientRes);
					}
					else {
						clientRes.writeHead(500, { 'content-type': 'application/json' });
						if (error)
							clientRes.write(JSON.stringify({ error: error.toString() }));
						clientRes.end(); // error
					}
				});
			}
			else {
				clientRes.statusCode = 404;
				clientRes.end(); // camera not found
			}
		}
		else {
			// static files
			serveStaticFiles(clientReq, clientRes, options);
		}
	});
})
.on('listening', function() {
	console.log('listening');
})
.listen(3000);

Stream = require('../node-rtsp-stream');
var ws = new Stream({
    name: 'name',
	ffmpegArgs: ['-i', 'rtsp://192.168.1.4:554/11', '-f', 'mpegts', '-codec:v', 'mpeg1video', '-bf', '0', '-codec:a', 'mp2', '-r', '30', '-'],
	httpServer: httpServer
});

