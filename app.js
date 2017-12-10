const http = require('http');
const https = require('https');
const ws = require('ws');
const fs = require('fs');
const zlib = require('zlib');
const assert = require('assert');
const crypto = require('crypto');
const stream = require('stream');
const url = require('url');
const path = require('path');
const child_process = require('child_process');
const config = require('./config.js');

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
		options.subresource = seps.length > 2 ? seps[2] : null;
		clientReq.setEncoding('utf8');
		var clientPostdata = '';
		clientReq.on('data', function(chunk) {
			clientPostdata += chunk; 
		});
		clientReq.on('end', function() {
			if (clientPostdata.length > 0) {
				try {
					options.body = JSON.parse(clientPostdata);
				} catch (e) {
					console.error('JSON parse error (' + e.message + ') on ' + clientPostData);
				}
			}
			return callback(null, options);
		});
	}
	else
		return callback(null, options);
}

function sendFile(pathname, clientRes) {
	const ext = path.parse(pathname).ext;
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
		'.doc': 'application/msword',
		'.mpd': 'application/dash+xml',	// mpeg dash manifest
		'.chk': 'video/webm'			// mpeg dash chunk, vp9 encoded in webm encapsulation
	};
	
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
}		

function serveStaticFiles(clientReq, clientRes, options) {
	var parsedUrl = url.parse(clientReq.url);
	var pathname = path.join(config.WWW_ROOT, parsedUrl.pathname);
	// deny request for parent of WWW_ROOT
	if (path.relative(config.WWW_ROOT, pathname).includes('..')) {
		clientRes.statusCode = 403;
		return clientRes.end();
	}
	var ext = path.parse(pathname).ext;
	fs.exists(pathname, function(exist) {
		if (!exist) {
			var seps = pathname.split(path.sep) || [];
			// if the file is not found, first check if this is a request for dash manifest
			// /www/webm_live/<camera_name>/manifest.mpd
			if (ext === '.mpd' && seps.length === 4) {
				var camera = cameras.find(function(camera) {
					return (seps[2] === camera.name);
				}, options);
				if (camera) {
					return camera.generateDashManifest(clientReq, clientRes, pathname, function(error) {
						if (error) {
							clientRes.statusCode = 500;
							return clientRes.end(error.message);
						}
						// Dash manifest ready
						return sendFile(pathname, clientRes);
					});
				}
			}
			// return 404
			clientRes.statusCode = 404;
			return clientRes.end('not found');
		}
		cameras.forEach(function(camera) {
			camera.checkDashRequest(clientReq); // update dash request flag 
		});
		sendFile(pathname, clientRes);
	});
}

class EsCamG02 {
	constructor(name, hostname, port, rtspPort, username, password, httpServer) {
		this.className = this.constructor.name;
		this.name = name;
		this.options = {
			method: 'GET',
			hostname: hostname,
			port: port,
			auth: username + ':' + password
		}
		this.rtspUrl = 'rtsp://' + hostname + ':' + rtspPort + '/11';
		this.optionsRight = Object.assign({}, this.options);
		this.optionsLeft = Object.assign({}, this.options);
		this.optionsUp = Object.assign({}, this.options);
		this.optionsDown = Object.assign({}, this.options);
		this.optionsRight.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=right';
		this.optionsLeft.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=left';
		this.optionsUp.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=up';
		this.optionsDown.path = '/web/cgi-bin/hi3510/ptzctrl.cgi?-step=1&-act=down';
		this.vpxClients = [];
		this.setupJsMpegStream(httpServer);
	}
	
	perform(clientReq, clientRes, clientOptions, callback) {
		var options;
		switch (clientOptions.subresource) {
			case 'stream':
				this.addVpxClient(clientRes);
				return callback(null, null); /* don't send response - already done in addVpxClient */
			default:
				switch (clientOptions.body.action) {
					case 'step':
						switch (clientOptions.body.direction) {
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
	
	// vp9/webm live stream. (this is not MPEG DASH. see below)
	// simple live streaming of vp9-encoded webm-encapsulated stream via http. clients simply use the
	// html <video> tag to play the feed.
	// this method is called in response to api get 'stream' subresource. the client request object
	// is appended to the list of clients array. if this is the first client then an ffmpeg process is run
	// to read rtsp stream from camera and transcode the video/audio feed into vp9/vorbis. this output
	// is broadcasted to all clients. (TODO: does not really work... clients[2..n] are unable to decode.
	// i think this is due to the missing header that only occur at the beginning of the stream. i've tried
	// to save the first 2 buffers and prepend these to every new connections but it doesn't work.. perhaps
	// MPEG DASH is the only solution to achieve vp9 live streaming. see below)
	addVpxClient(client) {
		var self = this;
		console.log('EsCamG02(' + this.name + ') vpx client connected (' + client.socket.remoteAddress + ':' + client.socket.remotePort + ')');
		client.writeHead(200, {
			'content-type': 'video/webm',
			'connection': 'close'
		});
		client.on('close', function() {
			console.log('EsCamG02(' + self.name + ') vpx client disconnected (' + client.socket.remoteAddress + ':' + client.socket.remotePort + ')');
			client.end();
			var pre = self.vpxClients.length;
			self.vpxClients = self.vpxClients.filter(function(client) {
				return (client != this);
			}, client /* 'this' in filter callback */);
			assert(self.vpxClients.length < pre);
			if (self.vpxClients.length == 0) {
				console.log('EsCamG02(' + self.name + ') no more vpx clients. stopping stream pid(' + self.vpxStream.pid + ')') ;
				self.vpxStream.kill('SIGTERM');
				delete self.vpxStream;
				delete self.streamHeaders;
			}
		});
		if (this.vpxClients.length > 0) {
			console.log('EsCamG02(' + this.name + ') not first vpx client ' + client.socket.remoteAddress + ':' + client.socket.remotePort);
			if (this.streamHeaders && this.streamHeaders.length > 1) {
				this.streamHeaders.forEach(function(header, index) {
					console.log('EsCamG02(' + self.name + ') sending header[' + index + '] len: '+ header.length);
					client.write(header);
				});
			}
		}
		this.vpxClients.push(client);
		if (this.vpxClients.length == 1) {
			console.log('EsCamG02(' + this.name + ') first vpx client. starting stream');
			assert(!this.vpxStream);
			this.vpxStream = child_process.spawn("ffmpeg", ['-i', this.rtspUrl, '-quality', 'realtime',
				'-speed', '5', '-tile-columns', '4', '-frame-parallel', '1', '-threads', '8', '-static-thresh', '0', '-qmin',
				'4', '-qmax', '48', '-error-resilient', '1', '-codec:v', 'libvpx-vp9', '-c:a', 'libopus', '-r', '23', '-f', 'webm', '-'], {
				detached: false
			});
			console.log('EsCamG02(' + this.name + ') first vpx client. stream started pid(' + this.vpxStream.pid + ')') ;
			this.vpxStream.stdout.on('data', function(data) {
				// save first 2 buffers as i believe these contain the headers. prepend these to all subsequent connections that
				// join mid-stream. doesn't work :/
				if (!self.streamHeaders)
					self.streamHeaders = [];
				if (self.streamHeaders.length < 2)
					self.streamHeaders.push(new Buffer(data));
				self.broadcastVpxClients(data);
			});
			this.vpxStream.stderr.on('data', function(data) {
				//console.log('stream.stderr: ', data.toString());
			});
			this.vpxStream.on('error', function(error) {
				console.log('EsCamG02(' + self.name + ') vpx stream error pid (' + this.pid + ') error: ' + error.message);
				if (self.vpxStream && this.pid == self.vpxStream.pid) {
					self.terminateVpxClients();
					delete self.vpxStream;
					delete self.streamHeaders;
				}
			}.bind(this.vpxStream)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.vpxStream referring to the new instance in callback.
			this.vpxStream.on('exit', function(code, signal) {
				console.log('EsCamG02(' + self.name + ') vpx stream exit pid (' + this.pid + ') code(' + code + ') signal(' + signal + ')');
				if (self.vpxStream && this.pid == self.vpxStream.pid) {
					self.terminateVpxClients();
					delete self.vpxStream;
					delete self.streamHeaders;
				}
			}.bind(this.vpxStream)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.vpxStream referring to the new instance in callback.
		}
	}
	
	// Jsmpeg live stream -- mpeg1 video over web socket
	// Sets up the web socket server to listen for incoming ws request. The clients
	// use jsmpeg to decode the mpeg1 video.
	setupJsMpegStream(httpServer) {
		var self = this;
		assert(!this.jsmpegWsServer);
		this.jsmpegWsServer = new ws.Server({
			server: httpServer,
			path: '/api/camera/' + this.name + '/jsmpegstream'
		});
		this.jsmpegWsServer.on('connection', function(socket) {
			self.onJsmpegClientConnect(socket);
		});
	}
	
	onJsmpegClientConnect(socket) {
		var self, streamHeader;
		self = this;
		console.log('EsCamG02(' + self.name + ') web socket connection ' + socket._socket.remoteAddress + ' (' + this.jsmpegWsServer.clients.length + ' total)');
		streamHeader = new Buffer(8);
		streamHeader.write('jsmp');
		streamHeader.writeUInt16BE(this.width, 4);
		streamHeader.writeUInt16BE(this.height, 6);
		socket.send(streamHeader, { binary: true });
		if (self.jsmpegWsServer.clients.length === 1) {
			assert(!self.jsmpegStream);
			self.jsmpegStream = child_process.spawn('ffmpeg',  ['-i', self.rtspUrl, '-f', 'mpegts', '-codec:v', 'mpeg1video', '-bf', '0', '-codec:a', 'mp2', '-r', '30', '-'], {
				detached: false
			});
			self.jsmpegStream.stdout.on('data', function(data) {
				self.jsmpegWsServer.clients.forEach(function(client) {
					if (client.readyState === ws.OPEN)
						client.send(data);
				});
			});
			self.jsmpegStream.stderr.on('data', function(data) {
				console.log('EsCamG02(' + self.name + ') jsmpeg stderr: ' + data.toString());
			});
			self.jsmpegStream.on('error', function(error) {
				console.log('EsCamG02(' + self.name + ') jsmpeg stream error pid (' + this.pid + ') error: ' + error.message);
				if (self.jsmpegStream && this.pid == self.jsmpegStream.pid)
					self.terminateJsmpegStream();
			}.bind(self.jsmpegStream)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.jsmpegStream referring to the new instance in callback.
			self.jsmpegStream.on('exit', function(code, signal) {
				console.log('EsCamG02(' + self.name + ') jsmpeg stream exit pid (' + this.pid + ') code(' + code + ') signal(' + signal + ')');
				if (self.jsmpegStream && this.pid == self.jsmpegStream.pid)
					self.terminateJsmpegStream();
			}.bind(self.jsmpegStream)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.jsmpegStream referring to the new instance in callback.
		}
		socket.on('close', function(code, message) {
			console.log('EsCamG02(' + self.name + ') web socket disconnected ' + this._socket.remoteAddress + ' (' + self.jsmpegWsServer.clients.length + ' total)');
			if (self.jsmpegWsServer.clients.length === 0)
				self.terminateJsmpegStream();
		});
	}
	
	terminateJsmpegStream() {
		if (this.jsmpegStream) {
			this.jsmpegStream.kill('SIGTERM');
			delete this.jsmpegStream;
		}
		this.jsmpegWsServer.clients.forEach(function(client) {
			client.terminate();
		});
	}
	
	broadcastVpxClients(data) {
		var self = this;
		self.vpxClients.forEach(function(client) {
			console.log('EsCamG02(' + self.name + ') broadcasting to client ' + client.socket.remoteAddress + ':' + client.socket.remotePort);
			client.write(data);
		});
	}
	
	terminateVpxClients() {
		this.vpxClients.forEach(function(client) {
			client.end();
		});
		this.vpxClients.splice(0, this.vpxClients.length);
	}
	
	deleteFolderRecursive(path) {
		if (fs.existsSync(path)) {
			fs.readdirSync(path).forEach(function(file, index) {
				var curPath = path + "/" + file;
				if (fs.lstatSync(curPath).isDirectory()) { // recurse
					this.deleteFolderRecursive(curPath);
				} else { // delete file
					fs.unlinkSync(curPath);
				}
			});
			fs.rmdirSync(path);
		}
	}
	
	// Mpeg DASH -- Dynamic Adaptive Streaming over HTTP
	// this method is called in response to a request for mpeg dash manifest that does not exist yet.
	// this camera instance has been identified as the one to generate the manifest and webm chunks.
	// two ffmpeg processes will be run. the first one runs forever until explicitly killed. this first
	// ffmpeg process generates the webm chunks and header files. then a second ffmpeg process runs that
	// uses the header files generated by the first ffmpeg process to generate an mpeg dash manifest.
	generateDashManifest(clientReq, clientRes, pathname, callback) {
		var self = this;
		if (self.dashProcess) {
			// another client has initiated the manifest generation
			// just wait 10s for the manifest file to be ready
			return setTimeout(function() {
				if (!fs.existsSync(path.join(config.WWW_ROOT, config.WEBM_CACHE, self.name, 'glass_live_manifest.mpd')))
					return callback({'message':'Failed to generate manifest'});
				callback(null);
			}, 15000);
		}
		self.deleteFolderRecursive(path.join(config.WWW_ROOT, config.WEBM_CACHE, self.name)); // this folder is not expected to exist. assert instead?
		fs.mkdir(path.join(config.WWW_ROOT, config.WEBM_CACHE, self.name), function(error) {
			if (error)
				return callback(error);
			// run first ffmpeg command to generate chunks and header files, this process will keep running
			// to generate chunks continuously.
			self.dashProcess = child_process.spawn("ffmpeg", [ '-rtsp_transport', 'tcp', '-i', self.rtspUrl,
				'-map', '0:0', '-c:v', 'libvpx-vp9', '-keyint_min', '40', '-g', '40', '-r', '20', '-speed', '5', '-tile-columns', '4', '-qmin', '4', '-qmax', '48',
				'-frame-parallel', '1', '-threads', '8', '-static-thresh', '0', '-max-intra-rate', '300', '-deadline', 'realtime',
				'-lag-in-frames', '0', '-error-resilient', '1', '-f', 'webm_chunk', '-header', config.WEBM_CACHE + '/' + self.name + '/' + 'glass_360.hdr',
				'-chunk_start_index', '1', config.WEBM_CACHE + '/' + self.name + '/' + 'glass_360_%d.chk', '-map', '0:1', '-c:a', 'libopus', '-f', 'webm_chunk',
				'-audio_chunk_duration', '2000', '-header', config.WEBM_CACHE + '/' + self.name + '/' + 'glass_171.hdr', '-chunk_start_index', '1',
				config.WEBM_CACHE + '/' + self.name + '/' + 'glass_171_%d.chk' ], {
				detached: false,
				cwd: config.WWW_ROOT
			});
			self.dashProcess.stderr.on('data', function(data) {
				//console.log('dashProcess.stderr: ', data.toString());
			});
			self.dashProcess.stdout.on('data', function(data) {
				//console.log('dashProcess.stdout: ', data.toString());
			});
			self.dashProcess.on('error', function(error) {
				self.terminateDash();
			});
			self.dashProcess.on('exit', function(code, signal) {
				self.terminateDash();
			});
			// wait 10s for header files to be generated as these are the required inuput for the second ffmpeg command
			setTimeout(function() {
				if (!fs.existsSync(path.join(config.WWW_ROOT, config.WEBM_CACHE, self.name, 'glass_360.hdr')))
					return callback({'message':'Failed to generate headers'});
				// run second ffmpeg command to generate manifest. this command exits immediately after manifest is generated
				// NOTE: do not use path.join to form the path arguments for this ffmpeg command or the generated manifest will contains invalid paths
				//       ffmpeg command doesn't like '\' as path separator
				self.dashManifestProcess = child_process.spawn("ffmpeg", [ '-f', 'webm_dash_manifest', '-live', '1',
					'-i', config.WEBM_CACHE + '/' + self.name + '/' + 'glass_360.hdr', '-f', 'webm_dash_manifest', '-live', '1', '-i',
					config.WEBM_CACHE + '/' + self.name + '/' + 'glass_171.hdr', '-c', 'copy', '-map', '0', '-map', '1', '-f', 'webm_dash_manifest',
					'-live', '1', '-adaptation_sets', 'id=0,streams=0 id=1,streams=1', '-chunk_start_index', '1',
					'-chunk_duration_ms', '2000', '-time_shift_buffer_depth', '7200', '-minimum_update_period', '7200',
					config.WEBM_CACHE + '/' + self.name + '/' + 'glass_live_manifest.mpd' ], {
					detached: false,
					cwd: config.WWW_ROOT
				});
				self.dashManifestProcess.stderr.on('data', function(data) {
					console.log('dashManifestProcess.stderr: ', data.toString());
				});
				self.dashManifestProcess.stdout.on('data', function(data) {
					console.log('dashManifestProcess.stdout:', data.toString());
				});
				self.dashManifestProcess.on('error', function(error) {
					self.terminateDash();
					callback(error);
				});
				// second ffmpeg command is expected to exit when the manifest file has been generated.
				// check for success exit code (0) and invoke the callback to return the manifest to client.
				self.dashManifestProcess.on('exit', function(code, signal) {
					// check self.dashManifestProcess as  the 'error' event above may have fired and callback already called
					if (!self.dashManifestProcess)
						return;
					if (code === 0)
						return callback(null); // success
					// failure: exit code != 0
					self.terminateDash();
					callback({'message':'Failed to generate manifest'});
				});
			}, 10000);
			setTimeout(self.checkCleanupDash.bind(self), 60000);
		});
	}
	
	// update dashChunkRequested flag that the checkCleanupDash timer checks every interval 
	checkDashRequest(clientReq) {
		if (clientReq.url.match('^/' + config.WEBM_CACHE + '/' + this.name + '/.*?\.chk$'))
			this.dashChunkRequested = true;
	}
	
	// if no requests come in for webm chunk when timer expires then kill ffmpeg dash process and cleanup
	checkCleanupDash() {
		if (!this.dashChunkRequested)
			return this.terminateDash();
		this.dashChunkRequested = false; // reset flag
		setTimeout(this.checkCleanupDash.bind(this), 60000); // and check again in 1 minute
	}
	
	// kill the ffmpeg process that generates webm chunks and delete the entire output folder
	terminateDash() {
		if (this.dashManifestProcess) {
			this.dashManifestProcess.kill('SIGTERM');
			delete this.dashManifestProcess;
		}
		if (this.dashProcess) {
			this.dashProcess.kill('SIGTERM');
			delete this.dashProcess;
		}
		this.deleteFolderRecursive(path.join(config.WWW_ROOT, config.WEBM_CACHE, this.name));
	}
}

var httpServer;
try {
	httpServer = https.createServer({
		cert: fs.readFileSync(config.TLS_SERVER_CERT),
		key: fs.readFileSync(config.TLS_SERVER_KEY),
		ca: fs.readFileSync(config.TLS_CA_CERT),
		requestCert: true,
		rejectUnauthorized: true
	});
}
catch (error) {
	console.log('Unable to create secure HTTPS server: ' + error.message + '. Check if certificates and keys exist.');
	httpServer = http.createServer();
}

const cameras = [
	new EsCamG02('front', '192.168.1.2', 80, 554, 'admin', 'admin', httpServer)
];

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
				camera.perform(clientReq, clientRes, options, function(error, cameraRes) {
					if (cameraRes) {
						clientRes.writeHead(cameraRes.statusCode, { 'content-type': 'text/plain'});
						cameraRes.pipe(clientRes);
					}
					else if (error) {
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
.on('tlsClientError', function(error, socket) {
	console.log('TLS handshake failed: ' + error.message.trim());
})
.on('listening', function() {
	console.log('Server listening on ' + this._connectionKey);
})
.listen(3000);
