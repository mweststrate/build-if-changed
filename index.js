#!/usr/bin/env node
/**
 * build-if-changed
 * Minimalistic build tools
 * (c) Michel Weststrate, 2015
 */

/**
 * TODO:
 * add command line parser
 * support -c (in directory option)
 * support watch mode
 * support one (or more build) file configs as input argument
 * support cleanup command
 * expose programmatic api
 */

var process = require('process');
var fs = require('fs');
var path = require('path');
var globby = require('globby');
var crypto = require('crypto');
var checksum = require('checksum');
var child_process = require('child_process');
var chalk = require('chalk');

var DEFAULT_BUILDFILE = 'buildconfig';
var CACHE_DIR = '/.buildifchanged';
var LOG_PREFIX = "[build if changed] ";

function main() {
	var configFileName = findConfigFile();
	if (!configFileName) {
		exit("No '" + DEFAULT_BUILDFILE + "' file found in " + process.cwd() + " or one of it's parent directories", 1);
	}

	var basePath = path.dirname(configFileName);
	log("Using config '" + path.basename(configFileName) + "' in '" + basePath + "'");
	var tasks = readConfigFile(configFileName);
	if (!fs.existsSync(basePath + CACHE_DIR))
		fs.mkdirSync(basePath + CACHE_DIR);
	if (!tasks.length) {
		exit("The build configuration file is empty", 3);
	}
	runTasksUntilExhausted(basePath, tasks);
}

function findConfigFile() {
	var currentDir = process.cwd();
	while(path.resolve(currentDir) !== path.resolve(currentDir + '/..')) {
		currentDir = path.resolve(currentDir);
		if (fs.existsSync(currentDir + '/' + DEFAULT_BUILDFILE))
			return path.resolve(currentDir + '/' + DEFAULT_BUILDFILE);
		currentDir += '/..';
	}
	return null;
}

function readConfigFile(filename) {
	var tasks = [];
	var currentTask;
	fs.readFileSync(filename, 'utf8').split('\n').forEach(function(line) {
		// New task definition
		if (line.charAt(0) === '[') {
			if (currentTask && currentTask.patterns.length === 0) {
				exit("command '" + currentTask.cmd + "' didn't specifiy any dependencies", 6);
			}
			currentTask = {
				cmd: line.replace(/^\s*\[/,'').replace(/]\s*$/,''),
				patterns: []
			}
			if (!currentTask.cmd)
				exit('task command should not be empty');
			currentTask.cmdMd5 = stringToMd5(currentTask.cmd);
			if (tasks.filter(
					function(task) {
						return task.cmdMd5 === currentTask.cmdMd5
					}
				).length > 0) {
				exit('task command should be unique')
			}
			tasks.push(currentTask);
		} else if (line.charAt(0) === '#') {
			// noop, comment
		} else if (line) {
			if (!currentTask)
				exit('buildconfig files should start with a shell command between brackets. E.g.: \n[sass *.js -o main.css]\n**/*.scss\n...more dependencies', 2);
			currentTask.patterns.push(line);
		}
	});
	return tasks;
}

function runTasksUntilExhausted(path, tasks) {
	var didSomeTaskRunInLastIteration = false;
	var didAnyTaskRun = false;
	var i = -1;
	function runNextTask(err, taskDidRun) {
		if (err) {
			console.err(err);
			exit("Encountered errors during run, exiting", 5);
		}
		if (taskDidRun) {
			didAnyTaskRun = didSomeTaskRunInLastIteration = true;
		}
		i += 1;
		if (i >= tasks.length) {
			if (didSomeTaskRunInLastIteration) {
				i = 0;
				didSomeTaskRunInLastIteration = false;
			} else {
				exit(didAnyTaskRun ? "FINISHED, some tasks did run" : "SKIPPED, no changes since last run");
			}
		}
		runTask(path, tasks[i], runNextTask);
	}

	runNextTask(null, false);
}

function runTask(path, task, callback) {
	globby(task.patterns, {
		cwd: path,
		nodir: true
	}).then(function(files) {
		var left = files.length;
		var md5s = new Array(left);

		function gotHashes() {
			runTaskIfHashesModified(path, task, md5s.map(function(md5, idx) {
				return md5 + ' ' + files[idx];
			}).join('\n'), callback);
		}

		if (files.length === 0) {
			gotHashes();
		} else {
			files.forEach(function(filename, idx) {
				checksum.file(path + '/' + filename, function(err, sha) {
					if (err)
						return void callback(err);
					md5s[idx] = sha;
					if (--left === 0)
						gotHashes();
				});
			});
		}
	}, callback);
}

function runTaskIfHashesModified(path, task, hashData, callback) {
	var hashesFile = path + '/' + CACHE_DIR + '/' + task.cmdMd5 + '-hashes';
	var existingHashes = fs.existsSync(hashesFile) ? fs.readFileSync(hashesFile, 'utf8') : '';
	if (existingHashes !== hashData) {
		executeTask(path, task, function(err) {
			if (err)
				return void callback(err);
			fs.writeFileSync(hashesFile, hashData, 'utf8');
			callback(null, true);
		});
	} else {
		callback();
	}
}

function executeTask(path, task, callback) {
	var command = task.cmd;
	var file, args;
	var options = {
		cwd: path,
		stdio: 'inherit'
	};

	// From: https://github.com/nodejs/node/blob/master/lib/child_process.js#L73
	if (process.platform === 'win32') {
		file = process.env.comspec || 'cmd.exe';
		args = ['/s', '/c', '"' + command + '"'];
		options.windowsVerbatimArguments = true;
	} else {
		file = '/bin/sh';
		args = ['-c', command];
	}

	log(chalk.dim("Starting:") + " " + chalk.bold(command));
	child_process.spawn(file, args, options)
		.on('exit', function(code, signal) {
			if (code === null)
				exit("task exited prematurely with " + signal  + " (task: '" + command + "')", 13);
			if (code !== 0)
				exit("task failed with exit code " + code + " (task: '" + command + "')", code);
			log(chalk.dim("Finished:") + " " + chalk.bold(command));
			callback();
		});
}

function stringToMd5(value) {
	return crypto.createHash('md5').update(value).digest('hex');
}

function exit(msg, code) {
	code = code || 0;
	if (code === 0)
		log(msg);
	else
		console.error(chalk.bold.red(LOG_PREFIX + "[error] " + msg));
	process.exit(code);
}

function log(msg) {
	console.log(chalk.cyan(LOG_PREFIX) + msg);
}

main();