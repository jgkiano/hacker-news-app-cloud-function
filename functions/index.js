const functions = require("firebase-functions");
const updateItem = require("./src/index");
const runOpts = {
	timeoutSeconds: 540,
	memory: "1GB"
};

exports.updateJobs = functions
	.region("europe-west2")
	.runWith(runOpts)
	.pubsub.schedule("0 */4 * * *")
	.onRun(context => {
		return updateItem("jobs");
	});

exports.updateStories = functions
	.region("europe-west2")
	.runWith(runOpts)
	.pubsub.schedule("0 */4 * * *")
	.onRun(context => {
		return updateItem("stories");
	});
