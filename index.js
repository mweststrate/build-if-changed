#!/usr/bin/env node
/**
 * build-if-changed
 * Minimalistic build tools
 * (c) Michel Weststrate, 2015
 */

/**
 * TODO:
 * add output specification
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
		return void exit("No '" + DEFAULT_BUILDFILE + "' file found in " + process.cwd() + " or one of it's parent directories", 1);
	}

	var basePath = path.dirname(configFileName);
	log("Using config '" + path.basename(configFileName) + "' in '" + basePath + "'");
	var tasks = readConfigFile(configFileName);
	if (!fs.existsSync(basePath + CACHE_DIR))
		fs.mkdirSync(basePath + CACHE_DIR);
	if (!tasks.length) {
		return void exit("The build configuration file is empty", 3);
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
			if (currentTask && currentTask.inputPatterns.length === 0) {
				return void exit("command '" + currentTask.cmd + "' didn't specifiy any dependencies", 6);
			}
			currentTask = {
				cmd: line.replace(/^\s*\[/,'').replace(/]\s*$/,''),
				inputPatterns: [],
				outputPatterns: []
			}
			if (!currentTask.cmd)
				return void exit('task command should not be empty');
			currentTask.cmdMd5 = stringToMd5(currentTask.cmd);
			if (tasks.filter(
					function(task) {
						return task.cmdMd5 === currentTask.cmdMd5
					}
				).length > 0) {
				return void exit('task command should be unique')
			}
			tasks.push(currentTask);
		} else if (line.charAt(0) === '#') {
			// noop, comment
		} else if (line) {
			if (!currentTask)
				return void exit('buildconfig files should start with a shell command between brackets. E.g.: \n[sass *.js -o main.css]\n**/*.scss\n...more dependencies', 2);
			if (line.indexOf('out:') === 0)
				currentTask.outputPatterns.push(line.substr(4));
			currentTask.inputPatterns.push(line);
		}
	});
	return tasks;
}

function runTasksUntilExhausted(path, tasks) {
	var didSomeTaskRunInLastIteration = false;
	var amountOfTaskRun = 0;
	var i = -1;
	function runNextTask(err, taskDidRun) {
		if (err) {
			console.err(err);
			return void exit("Encountered errors during run, exiting", 5);
		}
		if (taskDidRun) {
			amountOfTaskRun += 1;
			didSomeTaskRunInLastIteration = true;
		}
		i += 1;
		if (i >= tasks.length) {
			if (didSomeTaskRunInLastIteration) {
				i = 0;
				didSomeTaskRunInLastIteration = false;
			} else {
				return void exit(amountOfTaskRun > 0 ? "FINISHED, " + amountOfTaskRun + " task(s) completed" : "SKIPPED, no changes found");
			}
		}
		runTask(path, tasks[i], runNextTask);
	}

	runNextTask(null, false);
}

function runTask(path, task, callback) {
	// optimization: it isn't necessary to get the output hashes if the input changed anyway..
	getHashesFromGlobs(path, task.outputPatterns, function(outputErr, outputFilesHashData) {
		getHashesFromGlobs(path, task.inputPatterns, function(inputErr, inputFilesHashData) {
			if (outputErr || inputErr)
				return void callback(outputErr || inputErr);
			runTaskIfHashesModified(path, task, outputFilesHashData, inputFilesHashData, callback);
		});
	});
}

function runTaskIfHashesModified(path, task, outputFilesHashData, inputFilesHashData, callback) {
	var outputHashesFile = path + '/' + CACHE_DIR + '/' + task.cmdMd5 + '-out-hashes';
	var inputHashesFile  = path + '/' + CACHE_DIR + '/' + task.cmdMd5 + '-in-hashes';

	var existingInputHashes = fs.existsSync(inputHashesFile) ? fs.readFileSync(inputHashesFile, 'utf8') : '';
	var existingOutputHashes = fs.existsSync(outputHashesFile) ? fs.readFileSync(outputHashesFile, 'utf8') : '';

	var shouldBuild = true;
	var buildReason;

	if (!outputFilesHashData && task.outputPatterns.length) {
		buildReason = "(output files are missing)";
	} else if (existingOutputHashes !== outputFilesHashData) {
		buildReason = "(output files have changed)"
	} else if (existingInputHashes !== inputFilesHashData) {
		buildReason = "(input files have changed)";
	} else {
		shouldBuild = false;
	}
	
	if (shouldBuild) {
		// clean output files!
		globby(task.outputPatterns, {
			cwd: path,
			nodir: true
		}).then(function(files) {
			// TODO: delete those files
			
			// finally, build!
			executeTask(path, task, buildReason, function(err) {
				if (err)
					return void callback(err);
				getHashesFromGlobs(path, task.outputPatterns, function(err, freshOutputHashData) {
					if (err)
						return void callback(err);
					if (task.outputPatterns.length && !freshOutputHashData)
						return void exit("Executing task '" + task.cmd + "' didn't result in any files being written on disk! Patterns: " + task.outputPatterns.join(", "));
					fs.writeFileSync(outputHashesFile, freshOutputHashData, 'utf8');
					fs.writeFileSync(inputHashesFile,  inputFilesHashData,  'utf8');
					callback(null, true);
				});
			});
		}, callback);
	} else {
		callback();
	}
}

function executeTask(path, task, buildReason, callback) {
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

	log(chalk.dim("Starting:") + " " + chalk.bold(command) + " " + chalk.dim(buildReason));
	child_process.spawn(file, args, options)
		.on('exit', function(code, signal) {
			if (code === null)
				return void exit("task exited prematurely with " + signal  + " (task: '" + command + "')", 13);
			if (code !== 0)
				return void exit("task failed with exit code " + code + " (task: '" + command + "')", code);
			log(chalk.dim("Finished:") + " " + chalk.bold(command));
			callback();
		});
}

function getHashesFromGlobs(path, patterns, callback) {
	// Obtain and verify output hashes first
	globby(patterns, {
		cwd: path,
		nodir: true
	}).then(function(files) {
		var left = files.length;
		var md5s = new Array(left);

		function gotHashes() {
			callback(null, md5s.map(function(md5, idx) {
				return md5 + ' ' + files[idx];
			}).join('\n'));
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