// This doesn't need to be so complicated :)

class Promise {
	constructor() {}
	
	then(callback) {
		this.callback = callback;
		return this;
	}
	
	fullfill(error, result) {
		if (this.callback)
			this.callback(error, result);
		return this;
	}
}

module.exports = Promise;
