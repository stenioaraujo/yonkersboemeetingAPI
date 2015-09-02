var querystring = require("querystring");
var http = require("http");
var cheerio = require("cheerio");
var CACHE;

var HOST = "206.155.75.42";
var ACTUAL_YEAR = new Date().getFullYear();

// callback(data);
var getData = function(response, callback) {
	var data = ""
	
	response.on("data", function(chunk) {
		data += chunk;
	}).on("end", function() {
		data = data.replace(/\r|\n|\t/g, "");
		callback(data);
	})
};

function getMonthFromString(mon){
   return new Date(Date.parse(mon +" 1, 2012")).getMonth()+1
}

function fill(posInt, size, char) {
    var pad_char = typeof char !== 'undefined' ? char : '0';
    var pad = new Array(1 + size).join(pad_char);
    return (pad + posInt).slice(-pad.length);
}

// link - Public_agenda or MultipleMeetings link
// callback(links)
// 		links -> array of public_agenda links
var getMultipleMeetings = function(link, callback) {
	if (link.toLocaleString().match("^MultipleMeetings")) {
		var options = {
			hostname: HOST,
			path: "/"+link,
			port: 80,
			method: "GET"
		}
		
		http.request(options, function(res) {
			getData(res, function(data) {
				var $ = cheerio.load(data);
				var submits = $("input[value='Open Agenda']");
				var links = [];
				options.method = "POST";
				var postData = {
					__EVENTVALIDATION: $("input[name=__EVENTVALIDATION]").attr("value"),
					__VIEWSTATE: $("input[name=__VIEWSTATE]").attr("value"),
				}
				
				function loop(start, end, callback) {
					if (start < end) {
						postData[submits[start].attribs["name"]] = submits[start].attribs["value"];
						options.headers = {
					        'Content-Type': 'application/x-www-form-urlencoded',
					        'Content-Length': Buffer.byteLength(querystring.stringify(postData))
						}
						var request = http.request(options, function(res) {
							links.push(res.headers.location.slice(1).toLowerCase());
							loop(start+1, end, callback);
						});
						
						request.write(querystring.stringify(postData));
						request.end();
					} else {
						callback(links);
					}
				}
				loop(0, submits.length, callback);
			});
		}).end();
	} else {
		callback([link]);
	}
};

// Returns a object with all the result links. It has the determined Regex.
// callback(links)
// 		links: {"year/month/day": link}
var getRegexInfo = function(data, callback) {
	var link, results = {};
	
	if (data.match(ACTUAL_YEAR+"<")) {
		var regex = /<a href='([^']*)[^>]*>([0-9]+)<\/a>/g; // (1) = link (2) = day
		var month = data.match(">(.{1,15}) "+ACTUAL_YEAR+"<")[1]; // It should always work. If not, the page data is not correct.
		var links = [];
		
		while (true) {
			link = regex.exec(data);
			
			if (link === null) break;
			
			links.push(link);
		}
		
		function loop(i, end) {
			if (i < end) {
				getMultipleMeetings(links[i][1], function(arrayLinks) {
					results[ACTUAL_YEAR+"/"+fill(getMonthFromString(month), 2)+"/"+fill(links[i][2], 2)] = arrayLinks;
					
					loop(i+1, end);
				});
			} else {
				callback(results);
			}
		}
		loop(0, links.length);
	} else {
		callback(results);
	}
}

// html - the source code of the actual month page
// callback(links)
// 		links: {"year/month/day": link}
// links -> to store the links
// dir = previous|next; default next
var navigate = function(html, callback, links, dir) {
	if (links === undefined) links = {};
	if (dir === undefined) dir = "next";
	
	if (html.match(ACTUAL_YEAR+"<")) {
		$ = cheerio.load(html);
		
		var direction = $("a[title='Go to the "+dir+" month']").attr("href").match("'([^']+)','([^']+)").slice(1,3);
		var postData = querystring.stringify({
			__EVENTTARGET: direction[0],
			__EVENTARGUMENT: direction[1],
			__VIEWSTATE: $("input[name=__VIEWSTATE]").attr("value"),
			__EVENTVALIDATION: $("input[name=__EVENTVALIDATION]").attr("value")
		});
		
		var options = {
			hostname: HOST,
			path: "/calendar.aspx",
			port: 80,
			method: "POST",
		    headers: {
		        'Content-Type': 'application/x-www-form-urlencoded',
		        'Content-Length': Buffer.byteLength(postData)
		    }
		};
		
		var request = http.request(options, function(res) {
			getData(res, function(data) {
				getRegexInfo(data, function(lnks) {
					var keys = Object.keys(lnks);
					
					for (var i = keys.length - 1; i >= 0; i--) {
						links[keys[i]] = lnks[keys[i]];
					}

					navigate(data, callback, links, dir);
				});
			})
		});
		
		request.write(postData);
		request.end();
	} else {
		callback(links);
	}
};

var updateCache = function (callback) {
	http.request("http://"+HOST+"/calendar.aspx", function(res) {	
		getData(res, function(data) {
			getRegexInfo(data, function(links) {
				navigate(data, function(links) {
					navigate(data, function(links) {
						var keys = Object.keys(links);
						keys.sort();
						
						var sortedLinks = [];					
						for (var i = 0; i < keys.length; i++) {
							for (var j = 0; j < links[keys[i]].length; j++) {
								sortedLinks.push(links[keys[i]][j]);
							}
						}
						
						var apiResult = {
							numberEvents: sortedLinks.length,
							events: []
						}
						
						function loop(i, end) {
							if (i < end) {
								http.request("http://"+HOST+"/"+sortedLinks[i], function(res) {
									getData(res, function(data) {
										$ = cheerio.load(data);
										
										var event = {
											type: $("#lblMtgType").text(),
											when: {
												day: $("#lblDate").text(),
												time: $("#lblTime").text()
											},
											where: $("#lblLocation").text(),
											approved: data.match("This agenda has not been approved for public viewing") ? false : true
										}
										
										apiResult.events.push(event);
										
										loop(i+1, end);
									})
								}).end();
							} else {
								CACHE = apiResult;
								if (callback)
									callback();
							}
						}
						loop(0, sortedLinks.length);
					}, links, "next");
				}, links, "previous");
			});
		});
	}).end();
}

updateCache(function() {
	console.log("Cache Created!");
	
	setInterval(function() {
		updateCache();
	}, 1*6*1000);
	
	var server = http.createServer(function(req, res) {
		res.end(JSON.stringify(CACHE));
	});
	server.listen(3000);
});


