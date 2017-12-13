const http = require('http');
const child_process = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const config = require('./config.js');
const JsMpegStream = require('./stream-jsmpeg.js');
const HttpVp9Stream = require('./stream-httpvp9.js');
const MpegDashStream = require('./stream-mpegdash.js');

// Escam G02 IP camera
// This camera has 2 RTSP stream at http://ip:554/11 and http://ip:554/12. The stream is high quality.
// Feed from RTSP stream is transcoded into 3 different types of delivery/stream.
// 1. MPEG1 over web socket
//    Client uses jsmpeg javascript to render in a <canvas> 
// 2. VP9/WEBM over HTTP
//    Client uses HTML <video> control
// 3. MPEG DASH (VP9 WEBM chunk) over http
//    Client uses mpeg dash javascript on top of <video>
// See comments in stream-*.js for implementation details.
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
		this.jsmpegStream = new JsMpegStream(this.name, this.rtspUrl, httpServer);
		this.vp9Stream = new HttpVp9Stream(this.name, this.rtspUrl);
		this.mpegDashStream = new MpegDashStream(this.name, this.rtspUrl);
	}
	
	perform(clientReq, clientRes, clientOptions, callback) {
		var options;
		switch (clientOptions.subresource) {
			case 'stream':
				this.vp9Stream.addClient(clientRes);
				return callback(null, null); /* don't send response - already done in addClient */
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
	
	generateDashManifest(clientReq, clientRes, pathname, callback) {
		return this.mpegDashStream.generateManifest(clientReq, clientRes, pathname, callback);
	}
	
	checkDashRequest(clientReq) {
		this.mpegDashStream.checkRequest(clientReq);
	}
}

module.exports = EsCamG02;
