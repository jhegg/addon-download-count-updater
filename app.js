#!/usr/bin/env node

var program = require('commander');
var request = require('request');
var cheerio = require('cheerio');
var moment = require('moment');
var fs = require('fs');
var assert = require('assert');

program
  .version('0.0.1')
  .usage('-f <addons.json>')
  .option('-f, --file <file>', 'Path to JSON file with addon details (required)')
  .option('-u, --url <url>', 'Base URL to use for posting results (optional)')
  .option('-t --apiToken <token>', 'The API token required to post results (required if url is used)');

program.on('--help', function () {
  var addonJsonExample = '[\n' +
    '  {\n' +
    '    "name": "GoldCounter",\n' +
    '    "curseforge": "http://wow.curseforge.com/addons/goldcounter/",\n' +
    '    "wowinterface": "http://www.wowinterface.com/downloads/author-318870.html"\n' +
    '  }\n' +
    ']';

  console.log('  Example:');
  console.log('    $ addon-download-count-fetcher -f addon.json -u https://example.com -t mytoken');
  console.log('');
  console.log('    addon.json contents:');
  console.log(addonJsonExample);
  console.log('');
});

program.parse(process.argv);

if (!program.file) {
  console.error('Error:', 'The file argument was not provided.');
  program.help();
  process.exit(1);
}

if (program.url && !program.apiToken) {
  console.error('Error:', 'The --apiToken was not specified.');
  program.help();
  process.exit(1);
}

var jsonFile = program.file;
var url = program.url;
var apiToken = program.apiToken;
var apiRequest = request.defaults({
  baseUrl: url,
  headers: {"api-token": apiToken, "Content-Type": "application/json"}
});
var jsonFromFile;
var results = {};
var sourceUrls = {};

fs.readFile(jsonFile, parseJsonFile);

function parseJsonFile(err, data) {
  if (err) throw err;
  jsonFromFile = JSON.parse(data);
  if (jsonFromFile.length < 1) throw new Error('Expected JSON file to have at least one addon entry.');
  for (var addon in jsonFromFile) {
    var addonName = jsonFromFile[addon].name;
    if (addonName === undefined)
      throw new Error('"name" was missing for an addon entry in the JSON file.');

    var curseforgeUrl = jsonFromFile[addon].curseforge;
    if (curseforgeUrl === undefined)
      throw new Error('"curseforge" was missing for an addon entry in the JSON file.');

    var wowinterfaceUrl = jsonFromFile[addon].wowinterface;
    if (wowinterfaceUrl === undefined)
      throw new Error('"wowinterface" was missing for an addon entry in the JSON file.');

    sourceUrls[addonName] = {curseForgeUrl: curseforgeUrl, wowInterfaceUrl: wowinterfaceUrl};
    scrapeDownloadCountFromUrl(curseforgeUrl, addonName, getDownloadCountFromScrapedCurseForgeHtml);
    scrapeDownloadCountFromUrl(wowinterfaceUrl, addonName, getDownloadCountFromScrapedWowInterfaceHtml);
  }
}

function reportTotalIfReady(addonName, count) {
  if (results[addonName] === undefined) {
    results[addonName] = {};
    results[addonName].count = count;
    return;
  }

  results[addonName].count += count;
  console.log(moment().format(), addonName, results[addonName].count);

  if (url) {
    outputToRestApi(addonName);
  }
}

function outputToRestApi(addonName) {
  apiRequest.get({uri: '/addons', json: true}, function (error, response, body) {
    if (error || response.statusCode != 200) {
      console.error('Error attempting to fetch list of addons: statusCode=' + response.statusCode);
      console.error(body);
      return;
    }

    if (body.indexOf(addonName) === -1) {
      createAddonUsingRestApi(addonName, updateAddonCountsUsingRestApi);
    } else {
      console.log('Addon ' + addonName + ' found, skipping creation...');
      updateAddonCountsUsingRestApi(addonName);
    }
  });
}

function createAddonUsingRestApi(addonName, callback) {
  console.log('Addon ' + addonName + ' not found, we need to create it!');
  var curseForgeUrl = sourceUrls[addonName].curseForgeUrl;
  var wowInterfaceUrl = sourceUrls[addonName].wowInterfaceUrl;
  var urls = {curseForgeUrl: curseForgeUrl, wowInterfaceUrl: wowInterfaceUrl};

  apiRequest.post({
    uri: '/addons/' + addonName,
    json: true,
    body: urls
  }, function (error, response, body) {
    if (error || response.statusCode != 200) {
      console.error('Error attempting to create an addon: statusCode=' + response.statusCode);
      console.error(body);
      return;
    }

    console.log('Successfully created addon:', addonName);
    callback(addonName);
  });
}

function updateAddonCountsUsingRestApi(addonName) {
  console.log('Updating the download counts for ' + addonName)
  var count = results[addonName].count;
  apiRequest.post({
    uri: '/addons/' + addonName + '/downloads',
    json: true,
    body: {count: count}
  }, function (error, response, body) {
    if (error || response.statusCode != 200) {
      console.error('Error attempting to update download counts for ' + addonName + ': statusCode=' + response.statusCode);
      console.error(body);
      return;
    }

    console.log('Successfully updated download count to ' + count + ' for addon:', addonName);
  });
}

function getDownloadCountFromScrapedCurseForgeHtml(addonName, html) {
  var $ = cheerio.load(html);
  var downloadsElement = $('dt:contains("Downloads")');
  var downloadCountElement = downloadsElement.next();
  return Number(downloadCountElement.text());
}

function getDownloadCountFromScrapedWowInterfaceHtml(addonName, html) {
  var $ = cheerio.load(html);
  var titleElement = $('a:contains(' + addonName + ')');
  var titleRow = titleElement.parent().parent().parent();
  var downloadCountRow = titleRow.children().last();
  var downloadCountElement = downloadCountRow.children().first();
  return Number(downloadCountElement.text());
}

function scrapeDownloadCountFromUrl(url, addonName, callback) {
  request(url, function (error, response, html) {
    if (!error && response.statusCode == 200) {
      var count = callback(addonName, html);
      reportTotalIfReady(addonName, count);
    } else {
      if (error) throw error;
      console.error('Error: statusCode=' + response.statusCode + ', url=' + url)
    }
  });
}