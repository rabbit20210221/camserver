This service takes RTSP feed from IP cameras and transcode the stream into 3 different encoding for delivery over HTTP

1. MPEG1 over web socket.<br/>Client uses jsmpeg javascript to render in a `<canvas>`

2. VP9/WEBM over HTTP.<br/> Client uses HTML `<video>` control

3. MPEG DASH (VP9 WEBM chunk) over http<br/>Client uses mpeg dash javascript on top of `<video>`.<br/>See comments in stream-*.js for implementation details.

Currently only supports ESCam G02 IP camera, but support for other cameras can be easily added.
