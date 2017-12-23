const ws = require('ws');
const child_process = require('child_process');
const assert = require('assert');

const STREAM_MAGIC_BYTES = 'jsmp'; // see http://phoboslab.org/log/2013/09/html5-live-video-streaming-via-websockets

// Jsmpeg live stream -- mpeg1 video over web socket (https://github.com/phoboslab/jsmpeg)
// Sets up the web socket server to listen for incoming ws request. Client
// uses phoboslap jsmpeg javascript to decode the mpeg1 video and mpeg2 audio.
class JsMpegStream {
	
	constructor(name, rtspUrl, httpServer) {
		var self = this;
		this.name = name;
		this.rtspUrl = rtspUrl;
		this.wsServer = new ws.Server({
			server: httpServer,
			path: '/api/camera/' + this.name + '/jsmpegstream'
		})
		.on('connection', function(socket) {
			self.onConnection(socket);
		});
	}

	onConnection(socket) {
		var self, streamHeader;
		self = this;
		console.log('JsMpegStream(' + self.name + ') web socket connection ' + socket._socket.remoteAddress + ' (' + this.wsServer.clients.size + ' total)');
		streamHeader = new Buffer(8);
		streamHeader.write(STREAM_MAGIC_BYTES);
		// width and height: but setting these to zero seem to work too. perhaps the jsmpeg client javascript can get these from the mpeg1 data.
		// http://phoboslab.org/log/2013/09/html5-live-video-streaming-via-websockets
		streamHeader.writeUInt16BE(0, 4);
		streamHeader.writeUInt16BE(0, 6);
		socket.send(streamHeader, { binary: true });
		// on first client connection, start ffmpeg
		if (self.wsServer.clients.size === 1) {
			assert(!self.ffmpeg);
			self.ffmpeg = child_process.spawn('ffmpeg',  ['-i', self.rtspUrl, '-f', 'mpegts', '-codec:v', 'mpeg1video', '-bf', '0', '-codec:a', 'mp2', '-ar', '44100', '-ac', '1', '-b:a', '128k', '-r', '25', '-'], {
				detached: false
			});
			self.ffmpeg.stdout.on('data', function(data) {
				self.wsServer.clients.forEach(function(client) {
					if (client.readyState === ws.OPEN) {
						try {
							client.send(data);
						}
						catch (error) {}
					}
				});
			});
			self.ffmpeg.stderr.on('data', function(data) {
				//console.log('JsMpegStream(' + self.name + ') jsmpeg stderr: ' + data.toString());
			});
			self.ffmpeg.on('error', function(error) {
				console.log('JsMpegStream(' + self.name + ') jsmpeg stream error pid (' + this.pid + ') error: ' + error.message);
				if (self.ffmpeg && this.pid === self.ffmpeg.pid)
					self.terminate();
			}.bind(self.ffmpeg)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.ffmpeg referring to the new instance in callback.
			self.ffmpeg.on('exit', function(code, signal) {
				console.log('JsMpegStream(' + self.name + ') jsmpeg stream exit pid (' + this.pid + ') code(' + code + ') signal(' + signal + ')');
				if (self.ffmpeg && this.pid === self.ffmpeg.pid)
					self.terminate();
			}.bind(self.ffmpeg)); // bind the stream object so we can match in the callback. sometimes a quick connect and disconnect may result in self.ffmpeg referring to the new instance in callback.
		}
		socket.on('close', function(code, message) {
			console.log('JsMpegStream(' + self.name + ') web socket disconnected ' + (this._socket ? this._socket.remoteAddress : '') + ' (' + self.wsServer.clients.size + ' total)');
			// kill ffmpeg when there are no more clients
			if (self.wsServer.clients.size === 0)
				self.terminate();
		});
	}
	
	terminate() {
		if (this.ffmpeg) {
			this.ffmpeg.kill('SIGTERM');
			delete this.ffmpeg;
		}
		this.wsServer.clients.forEach(function(client) {
			client.terminate();
		});
	}
}

module.exports = JsMpegStream;
