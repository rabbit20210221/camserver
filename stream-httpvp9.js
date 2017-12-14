const child_process = require('child_process');
const assert = require('assert');

// VP9/webm live stream. (this is not MPEG DASH)
// simple live streaming of vp9-encoded webm-encapsulated stream via http. clients simply use the
// html <video> tag to play the feed.
// an api call to get the 'stream' subresource (see camera module), would have the response object
// appended to the list of clients array. if this is the first client then an ffmpeg process is run
// to read rtsp stream from camera and transcode the video/audio feed into vp9/vorbis. this output
// is broadcasted to all clients. (TODO: does not really work... clients[2..n] are unable to decode.
// i think this is due to the missing header that only occur at the beginning of the stream. i've tried
// to save the first 2 buffers and prepend these to every new connections but it doesn't work.. perhaps
// MPEG DASH is the only solution to achieve vp9 live streaming. stream-mpegdash)
class HttpVp9Stream {
	constructor(name, rtspUrl) {
		this.name = name;
		this.rtspUrl = rtspUrl;
		this.clients = [];
	}
	
	addClient(client) {
		var self = this;
		console.log('HttpVp9Stream(' + this.name + ') vpx client connected (' + client.socket.remoteAddress + ':' + client.socket.remotePort + ')');
		client.writeHead(200, {
			'content-type': 'video/webm',
			'connection': 'close'
		});
		client.on('close', function() {
			console.log('HttpVp9Stream(' + self.name + ') vpx client disconnected (' + client.socket.remoteAddress + ':' + client.socket.remotePort + ')');
			client.end();
			var pre = self.clients.length;
			self.clients = self.clients.filter(function(client) {
				return (client != this);
			}, client /* 'this' in filter callback */);
			assert(self.clients.length === pre - 1);
			if (self.clients.length === 0) {
				console.log('HttpVp9Stream(' + self.name + ') no more vpx clients. stopping stream pid(' + self.ffmpeg.pid + ')') ;
				self.terminate();
			}
		});
		if (this.clients.length > 0) {
			console.log('HttpVp9Stream(' + this.name + ') not first vpx client ' + client.socket.remoteAddress + ':' + client.socket.remotePort);
			if (this.headers) {
				this.headers.forEach(function(header, index) {
					console.log('HttpVp9Stream(' + self.name + ') sending header[' + index + '] len: '+ header.length);
					client.write(header);
				});
			}
		}
		this.clients.push(client);
		if (this.clients.length === 1) {
			console.log('HttpVp9Stream(' + this.name + ') first vpx client. starting stream');
			assert(!this.ffmpeg);
			this.ffmpeg = child_process.spawn("ffmpeg", ['-i', this.rtspUrl, '-quality', 'realtime',
				'-speed', '5', '-tile-columns', '4', '-frame-parallel', '1', '-threads', '8', '-static-thresh', '0', '-qmin',
				'4', '-qmax', '48', '-error-resilient', '1', '-codec:v', 'libvpx-vp9', '-c:a', 'libopus', '-r', '23', '-f', 'webm', '-'], {
				detached: false
			});
			console.log('HttpVp9Stream(' + this.name + ') first vpx client. stream started pid(' + this.ffmpeg.pid + ')') ;
			this.ffmpeg.stdout.on('data', function(data) {
				// save first 2 buffers as i believe these contain the headers. prepend these to all subsequent connections that
				// join mid-stream. doesn't work :/
				if (!self.headers)
					self.headers = [];
				if (self.headers.length < 2)
					self.headers.push(new Buffer(data));
				self.broadcast(data);
			});
			this.ffmpeg.stderr.on('data', function(data) {
				//console.log('stream.stderr: ', data.toString());
			});
			this.ffmpeg.on('error', function(error) {
				console.log('HttpVp9Stream(' + self.name + ') vpx stream error pid (' + this.pid + ') error: ' + error.message);
				if (self.ffmpeg && this.pid === self.ffmpeg.pid)
					self.terminate();
			}.bind(this.ffmpeg)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.ffmpeg referring to the new instance in callback.
			this.ffmpeg.on('exit', function(code, signal) {
				console.log('HttpVp9Stream(' + self.name + ') vpx stream exit pid (' + this.pid + ') code(' + code + ') signal(' + signal + ')');
				if (self.ffmpeg && this.pid === self.ffmpeg.pid)
					self.terminate();
			}.bind(this.ffmpeg)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.ffmpeg referring to the new instance in callback.
		}
	}
	
	broadcast(data) {
		var self = this;
		self.clients.forEach(function(client) {
			//console.log('HttpVp9Stream(' + self.name + ') broadcasting to client ' + client.socket.remoteAddress + ':' + client.socket.remotePort);
			client.write(data);
		});
	}
	
	terminate() {
		if (this.ffmpeg) {
			this.ffmpeg.kill('SIGTERM');
			delete this.ffmpeg;
		}
		this.clients.forEach(function(client) {
			client.end();
		});
		this.clients = [];
		delete this.headers;
	}
}

module.exports = HttpVp9Stream;
