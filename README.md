This service takes RTSP feed from IP cameras and transcode the stream into 3 different encoding.

1. MPEG DASH 
See https://github.com/Dash-Industry-Forum/dash.js/wiki

2. MPEG-2 over websocket
Uses JSmpeg client-side javascript for decoding in the browser
see https://github.com/phoboslab/jsmpeg

3. Plain VP9 over HTTP

Currently only supports ESCam G02 IP camera, but support for other cameras can be easily added.
