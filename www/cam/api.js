var okToSend = true; // avoid flooding the camera api with request
function apiCall(uri, requestBody) {
	if (!okToSend)
		console.log("apiCall still waiting on previous request to finish.");
	var xhttp = new XMLHttpRequest();
	xhttp.onreadystatechange = function() {
		if (this.readyState == 4) {
			//document.getElementById("demo").innerHTML = this.responseText;
			console.log("apiCall uri(" + uri + ") status(" + this.status +") response( " + this.responseText + ")");
			okToSend = true;
		}
	};
	xhttp.open("POST", uri, true);
	xhttp.send(requestBody);
}
// https://stackoverflow.com/questions/217578/how-can-i-determine-whether-a-2d-point-is-within-a-polygon
function polygonHitTest(coords, testx, testy)
{
	var i, j, c = false;
	for (i = 0, j = coords.length-1; i < coords.length; j = i++)
		if (((coords[i].y>testy) != (coords[j].y>testy)) && (testx < (coords[j].x-coords[i].x) * (testy-coords[i].y) / (coords[j].y-coords[i].y) + coords[i].x))
			c = !c;
	return c;
}
function setupApiHooks(id) {
	var v = document.getElementById(id);
	console.log("size: " + v.clientWidth + " * " + v.clientHeight);
	// the rectangular video client area is divided into 4 triangles
	var regions = [
		[ { x: 0, y: v.clientHeight }, { x: v.clientWidth, y: v.clientHeight }, { x: v.clientWidth/2, y: v.clientHeight/2} ], // top triangle
		[ { x: v.clientWidth, y: 0 }, { x: v.clientWidth, y: v.clientHeight }, { x: v.clientWidth/2, y: v.clientHeight/2} ], // right triangle
		[ { x: v.clientWidth, y: 0 }, { x: 0, y: 0 }, { x: v.clientWidth/2, y: v.clientHeight/2} ], // bottom triangle
		[ { x: 0, y: v.clientHeight }, { x: 0, y: 0 }, { x: v.clientWidth/2, y: v.clientHeight/2} ]  // left triangle
	];
	v.onclick = function(p) {
		var testX = p.offsetX;
		var testY = v.clientHeight - p.offsetY;
		console.log(testX + "," + testY);
		for (var i = 0; i < regions.length; i++) {
			var hit = polygonHitTest(regions[i], testX, testY);
			if (hit) { // which triangle did it hit
				var direction;
				switch (i) {
					case 0: console.log("up"); direction = "up" ;break;
					case 1: console.log("right"); direction = "right" ;break;
					case 2: console.log("down"); direction = "down" ;break;
					case 3: console.log("left"); direction = "left" ;break;
				}
				apiCall("/api/camera/" + id, "{\"action\":\"step\",\"direction\":\"" + direction + "\"}");
				break;
			}
		}
	};
}
