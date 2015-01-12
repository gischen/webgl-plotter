/** The Cache class represents the second layer of cache. The only methods for
    external use are ensureData and limitMemory. Dynamic loading of data is not
    fully implemented, but some instance fields for that purpose have been
    declared and some methods implemented. */

function Cache (requester) {
    /* The dataCache maps UUID to an object that maps the point width exponent to
       cached data. The array contains cached entries, objects that store a start
       time, end time, and data; the cached entries never overlap, are consolidated
       when possible, and are stored sequentially. */
    this.dataCache = {};

    // The total number of data points that have been cached.
    this.loadedData = 0;
    this.loadedStreams = {}; // maps a stream's uuid to the total number of points that have been cached for that stream
    this.lastTimes = {}; // maps a stream's uuid to the time of the last pint where there is valid data, obtained from the server
    this.pollingBrackets = false; // whether or not we are periodically checking if the brackets have changed
    this.bracketInterval = 5000;
    
    this.queryLow = [-1152921504607, 153025];
    this.queryHigh = [3458764513820, 540927];
    this.pweHigh = 62;
    
    // The following fields are for rate control
    this.currPWE = undefined;
    this.secondaryPWE = undefined;
    this.pendingSecondaryRequests = 0;
    this.pendingSecondaryRequestData = {};
    this.pendingRequests = 0;
    
    // So we can make the requests for data when necessary
    this.requester = requester;
}

/* The start time and end time are two-element arrays. */
function CacheEntry(startTime, endTime, data) {
    this.start_time = startTime;
    this.end_time = endTime;
    this.cached_data = data;
    this.cached_drawing = {};
    this.inPrimaryCache = false;
    this.inSecondaryCache = true;
}

/* Ensures that CACHE, an array of cache entries, is not corrupted. Included
   for debugging. */
Cache.prototype.validateCache = function (cache) {
        var currEntry;
        var invalid = false;
        var condition = 0;
        for (var i = 0; i < cache.length; i++) {
            currEntry = cache[i];
            if (currEntry == undefined) {
                invalid = true;
                condition = 1;
            } else if (currEntry.end_time <= currEntry.start_time) {
                invalid = true;
                condition = 2;
            } else if (i > 0 && currEntry.start_time <= cache[i - 1].end_time) {
                invalid = true;
                condition = 3;
            }
            if (invalid) {
                alert("CORRUPTED CACHE!!! " + condition);
                console.log(cache);
                console.log(this.dataCache);
                return true;
            }
        }
        return false;
    };

/* Ensures that loadedData is correct. Returns true if it is correct, and
   false if it is corrupted. This function is included for debugging. */
Cache.prototype.validateLoaded = function () {
        var total = 0;
        var uuid;
        var pw;
        var i;
        var cache;
        var dataCache = this.dataCache;
        for (uuid in dataCache) {
            if (dataCache.hasOwnProperty(uuid)) {
                for (pw in dataCache[uuid]) {
                    if (dataCache[uuid].hasOwnProperty(pw)) {
                        cache = dataCache[uuid][pw];
                        for (i = 0; i < cache.length; i++) {
                            total += getCacheEntryLength(cache[i]);
                        }
                    }
                }
            }
        }
        console.log(total);
        console.log(this.loadedData);
        return total == this.loadedData;
    };

/* Checks if there are any holes in a cache entry and prints out information
   about the holes if they exist. Used for debugging. */
function validateContiguous(cacheEntry, pwe) {
    var di;
    var pw = Math.pow(2, pwe);
    var diLimit = getCacheEntryLength(cacheEntry) - 1;
    for (di = 0; di < diLimit; di++) {
        if (((cacheEntry.cached_data[di + 1][0] - cacheEntry.cached_data[di][0]) * 1000000) + cacheEntry.cached_data[di + 1][1] - cacheEntry.cached_data[di][1] != pw) {
            console.log('Gap');
            console.log(((cacheEntry.cached_data[di + 1][0] - cacheEntry.cached_data[di][0]) * 1000000) + cacheEntry.cached_data[di + 1][1] - cacheEntry.cached_data[di][1]);
            console.log(pw);
            console.log(di);
        }
    }
}

/* Ensures that the stream with the specified UUID has data cached from
   STARTTIME to ENDTIME at the point width corresponding to POINTWIDTHEXP, or
   floor(lg(POINTWIDTH)). If it does not, data are procured from the server and
   added to the cache so the extent of its data is at least from STARTTIME to
   ENDTIME. STARTTIME and ENDTIME are specified in UTC (Universal Coord. Time).
   Once the data is found or procured, CALLBACK is called with the Cache Entry
   containing the data as its argument. If another call to this function i
   pending (it has requested data from the server) for a certain stream, any
   more calls for that stream will not result in a GET request (so this
   function doesn't fall behind user input).
   
   STARTTIME and ENDTIME are aliased in the cache, so pass in a copy. If you
   don't, editing those same variables later could make the cache invalid.
   
   */
Cache.prototype.getData = function (uuid, pointwidthexp, startTime, endTime, callback, caching) {
        pointwidthexp = Math.min(this.pweHigh, pointwidthexp);
        var halfPW = expToPW(pointwidthexp - 1);
        var startlow = [this.queryLow[0], this.queryLow[1]];
        var endlow = [this.queryLow[0], this.queryLow[1]];
        var starthigh = [this.queryHigh[0], this.queryHigh[1]];
        var endhigh = [this.queryHigh[0], this.queryHigh[1]];
        
        addTimes(startlow, halfPW);
        addTimes(endlow, halfPW);
        addTimes(endlow, [0, 1]);
        subTimes(starthigh, halfPW);
        subTimes(starthigh, [0, 1]);
        subTimes(endhigh, halfPW);
        
        startTime = boundToRange(startTime, startlow, starthigh);
        endTime = boundToRange(endTime, endlow, endhigh);
        var dataCache = this.dataCache;
        // Create the mapping for this stream if it isn't already present
        if (!dataCache.hasOwnProperty(uuid)) {
            dataCache[uuid] = {};
            this.loadedStreams[uuid] = 0;
        }
        var cache;
        // Find the relevant cache, creating it if necessary
        if (dataCache[uuid].hasOwnProperty(pointwidthexp)) {
            cache = dataCache[uuid][pointwidthexp];
        } else {
            cache = [];
            dataCache[uuid][pointwidthexp] = cache;
        }
        var indices = getIndices(cache, startTime, endTime);
        var i = indices[0];
        var j = indices[1];
        var startsBefore = indices[2];
        var endsAfter = indices[3];
        var queryStart = startsBefore ? startTime : cache[i].end_time;
        var queryEnd = endsAfter ? endTime : cache[j].start_time;
        
        var numRequests = j - i + startsBefore + endsAfter; 
        if (numRequests == 0) {
            callback(cache[i]);
        } else {
            // Fetch the data between the cache entries, and consolidate into one entry
            var si = i;
            var numReceived = 0;
            var self = this;
            var urlCallback = function (streamdata, start, end) {
                    var callbackToUse;
                    if (++numReceived == numRequests) {
                        callbackToUse = callback;
                    } else {
                        callbackToUse = function () {};
                    }
                    if (dataCache.hasOwnProperty(uuid) && dataCache[uuid][pointwidthexp] == cache) { // If the stream or pointwidth has been deleted to limit memory, just return and don't cache
                        var data;
                        try {
                            data = JSON.parse(streamdata)[0].XReadings;
                        } catch (err) {
                            console.log('Invalid data response from server: ' + err);
                            console.log(streamdata);
                            // Just use the previous data that was cached for drawing
                            callback(undefined);
                            return;
                        }
                        self.insertData(uuid, cache, data, start, end, callbackToUse);
                    }
                };
            
            if (numRequests == 1) {
                this.makeDataRequest(uuid, queryStart, queryEnd, pointwidthexp, halfPW, urlCallback, caching);
            } else {
                if (startsBefore) {
                    i--;
                }
                if (endsAfter) {
                    j++;
                }
                this.makeDataRequest(uuid, queryStart, cache[i + 1].start_time, pointwidthexp, halfPW, urlCallback, caching);
                for (var k = i + 1; k < j - 1; k++) {
                    this.makeDataRequest(uuid, cache[k].end_time, cache[k + 1].start_time, pointwidthexp, halfPW, urlCallback, caching);
                }
                this.makeDataRequest(uuid, cache[j - 1].end_time, queryEnd, pointwidthexp, halfPW, urlCallback, caching);
            }
        }
    };

/* Gets all the points where the middle of the interval is between queryStart
   and queryEnd, including queryStart but not queryEnd. HALFPWNANOS should be
   Math.pow(2, pointwidthexp - 1). */
Cache.prototype.makeDataRequest = function (uuid, queryStart, queryEnd, pointwidthexp, halfpwnanos, callback, caching) {
        /* queryStart and queryEnd are the start and end of the query I want,
        in terms of the midpoints of the intervals I get back; the real archiver
        will give me back all intervals that touch the query range. So I shrink
        the range by half a pointwidth on each side to compensate for that. */
        if (pointwidthexp == 0) { // edge case. We don't want to deal with half nanoseconds
            halfpwnanos = [0, 0];
        }
        var trueStart = addTimes(queryStart.slice(0), halfpwnanos);
        var trueEnd = subTimes(subTimes(queryEnd.slice(0), halfpwnanos), [0, 1]); // subtract a nanosecond because we exclude the end time
        
        if (cmpTimes(trueEnd, trueStart) <= 0) { // it's possible for this to happen, if the range is smaller than an interval
            trueEnd[0] = trueStart[0];
            trueEnd[1] = trueStart[1];
            subTimes(trueStart, [0, 1]);
        }
        
        var req = uuid + '?starttime=' + timeToStr(trueStart) + '&endtime=' + timeToStr(trueEnd) + '&unitoftime=ns&pw=' + pointwidthexp;
        if (caching) {
            this.requester.makeDataRequest(req, function (data) {
                    callback(data, queryStart, queryEnd);
                }, 'text');
        } else {
            this.queueRequest(req, function (data) {
                    callback(data, queryStart, queryEnd);
                }, 'text', pointwidthexp);
        }
    };

Cache.prototype.queueRequest = function (url, callback, datatype, pwe) {
        if (this.pendingRequests == 0) {
            this.currPWE = pwe;
        }
        var self = this;
        if (this.currPWE == pwe) {
            this.pendingRequests++;
            this.requester.makeDataRequest(url, function (data) {
                    self.pendingRequests--;
                    callback(data);
                    if (self.pendingRequests == 0) {
                        self.effectSecondaryRequests();
                    }
                }, datatype, function () {
                    self.pendingRequests--;
                    if (self.pendingRequests == 0) {
                        self.effectSecondaryRequests();
                    }
                });
        } else {
            if (pwe != this.secondaryPWE) {
                this.secondaryPWE = pwe;
                this.pendingSecondaryRequests = 0;
                this.pendingSecondaryRequestData = {};
            }
            this.pendingSecondaryRequests++;
            var id = setTimeout(function () {
                    if (self.pendingSecondaryRequestData.hasOwnProperty(id)) {
                        self.requester.makeDataRequest(url, function (data) {
                                callback(data);
                            }, datatype);
                        self.pendingSecondaryRequests--;
                        delete self.pendingSecondaryRequestData[id];
                    }
                }, 1000);
            this.pendingSecondaryRequestData[id] = [url, callback, datatype];
        }
    };

Cache.prototype.effectSecondaryRequests = function () {
        if (this.secondaryPWE == undefined || this.pendingSecondaryRequests == 0) {
            return;
        }
        this.currPWE = this.secondaryPWE;
        this.pendingRequests = this.pendingSecondaryRequests;
        this.secondaryPWE = undefined;
        var entry;
        var pendingData = this.pendingSecondaryRequestData;
        var self = this;
        for (var id in pendingData) {
            if (pendingData.hasOwnProperty(id)) {
                clearTimeout(id);
                entry = pendingData[id];
                this.requester.makeDataRequest(entry[0], (function (cb) {
                        return function (data) {
                                self.pendingRequests--;
                                cb(data);
                            };
                    })(entry[1]), entry[2], function () {
                        selfpendingRequests--;
                    });
            }
        }
        this.pendingSecondaryRequestData = {};
        this.pendingSecondaryRequests = 0;
    };

Cache.prototype.insertData = function (uuid, cache, data, dataStart, dataEnd, callback) {
        var indices = getIndices(cache, dataStart, dataEnd);
        var i = indices[0];
        var j = indices[1];
        var startsBefore = indices[2];
        var endsAfter = indices[3];
        if (i == j && !startsBefore && !endsAfter) {
            callback(cache[i]);
            return;
        }
        var dataBefore;
        var dataAfter;
        var cacheStart;
        var cacheEnd;
        var m = 0; // the first index of data that we need
        var n = data.length; // the first index of data that we don't need, where n > m
        if (startsBefore) {
            cacheStart = dataStart;
            dataBefore = [];
        } else {
            cacheStart = cache[i].start_time;
            dataBefore = cache[i].cached_data;
            if (data.length > 0) {
                // We want to get rid of overlap
                m = binSearchCmp(data, cache[i].end_time, cmpTimes);
                if (cmpTimes(data[m], cache[i].end_time) < 0) {
                    m++;
                }
            }
        }
        if (endsAfter) {
            cacheEnd = dataEnd;
            dataAfter = [];
        } else {
            cacheEnd = cache[j].end_time;
            dataAfter = cache[j].cached_data;
            if (data.length > 0) {
                // We want to get rid of overlap
                n = binSearchCmp(data, cache[j].start_time, cmpTimes)
                if (cmpTimes(data[n], cache[j].start_time) >= 0) {
                    n--;
                }
                n++;
            }
        }
        var cacheEntry = new CacheEntry(cacheStart, cacheEnd, $.merge($.merge(dataBefore, [data.slice(m, n)]), dataAfter));
        var loadedStreams = this.loadedStreams;
        var entryLength;
        for (var k = i; k <= j; k++) {
            // Update the amount of data has been loaded into the cache
            entryLength = getCacheEntryLength(cache[k]);
            this.loadedData -= entryLength;
            loadedStreams[uuid] -= entryLength;
            
            // Dispose of the geometries to avoid leaking memory
            removeFromSecCache(cache[k]);
        }
        entryLength = getCacheEntryLength(cacheEntry); // Perhaps we could optimize this? Probably not necessary though.
        this.loadedData += entryLength;
        loadedStreams[uuid] += entryLength;
        cache.splice(i, j - i + 1, cacheEntry);
        callback(cacheEntry);
    };

/* Given CACHE, an array of cache entries, and a STARTTIME and an ENDTIME,
   provides the necessary information to determine what data in that interval
   is not present in CACHE (where the interval includes STARTTIME but does not
   include ENDTIME). Returns a four element array. The first element is a number
   i such that STARTTIME either occurs in the cache entry at index i or between
   the cache entries at indices i - 1 and i. The second element is a number j
   such that ENDTIME either occurs in the cache entry at index j or between the
   cache entries at indices j and j + 1. The third element, a boolean, is false
   if STARTTIME occurs in the cache entry at index i and true if it is between
   the cache entries at indices i - 1 and i. The fourth element, also a boolean,
   false if ENDTIME occurs in the cache entry at index j and true if it is
   between the cache entries at indices j and j + 1 */
function getIndices(cache, startTime, endTime) {
    var startsBefore; // false if startTime starts during the cacheEntry at index i, true if it starts before
    var endsAfter; // false if endTime ends during the cacheEntry at index j, true if it ends after
    
    // Figure out whether the necessary data is in the cache
    var i, j;
    if (cache.length > 0) {
        // Try to find the cache entry with data, or determine if there is no such entry
        i = binSearchCmp(cache, {start_time: startTime}, cmpEntryStarts);
        if (cmpTimes(startTime, cache[i].start_time) < 0) {
            i--;
        } // Now, startTime is either in entry at index i, or between index i and i + 1, or at the very beginning
        if (i == -1) {
            // new data starts before all existing records
            i = 0;
            startsBefore = true;
        } else if (cmpTimes(startTime, cache[i].end_time) <= 0) {
            // new data starts in cache entry at index i
            startsBefore = false;
        } else {
            // new data starts between cache entries at index i and i + 1
            startsBefore = true;
            i++; // so we don't delete the entry at index i
        }
        
        j = binSearchCmp(cache, {end_time: endTime}, cmpEntryEnds); // endTime is either in entry at index j, or between j - 1 and j, or between j and j + 1
        if (cmpTimes(endTime, cache[j].end_time) > 0) {
            j++;
        } // Now, endTime is either in entry at index j, or between index j - 1 and j, or at the very end
        if (j == cache.length) {
            // new data ends after all existing records
            j -= 1;
            endsAfter = true;
        } else if (cmpTimes(endTime, cache[j].start_time) >= 0) {
            // new data ends in cache entry at index j
            endsAfter = false;
        } else {
            // new data ends between cache entries at index j - 1 and j
            endsAfter = true;
            j--; // So we don't delete the entry at index j
        }
    } else {
        // Set variables so the first entry is created
        startsBefore = true;
        i = 0;
        
        endsAfter = true;
        j = -1;
    }
    return [i, j, startsBefore, endsAfter];
}

function cmpEntryStarts(entry1, entry2) {
    return cmpTimes(entry1.start_time, entry2.start_time);
}

function cmpEntryEnds(entry1, entry2) {
    return cmpTimes(entry1.end_time, entry2.end_time);
}

/* Excise the portion of the cache for the stream with UUID where the time is
   strictly greater than LASTTIME. The excising is done at all resolutions.
   LASTTIME is specified in milliseconds in Universal Coordinated Time (UTC). */
Cache.prototype.trimCache = function (uuid, lastTime) {
        var dataCache = this.dataCache;
        var data, datalength;
        if (dataCache.hasOwnProperty(uuid)) {
            var cache = dataCache[uuid];
            for (var resolution in cache) {
                if (cache.hasOwnProperty(resolution)) {
                    var entries = cache[resolution];
                    if (entries.length == 0) {
                        continue;
                    }
                    var index = binSearchCmp(entries, lastTime, cmpTimes);
                    if (index > 0 && cmpTimes(entries[index].start_time, lastTime) > 0 && cmpTimes(entries[index - 1].end_time, lastTime) > 0) {
                        index--;
                    }
                    if (cmpTimes(entries[index].start_time, lastTime) <= 0 && (datalength = getCacheEntryLength(entries[index])) > 0) {
                        data = entries[index].cached_data;
                        var entryIndex = binSearchCmp(data, [lastTime], cmpFirstTimes); // Needs to be updated
                        if (cmpFirstTimes(data[entryIndex], [lastTime]) <= 0) {
                            entryIndex++;
                        }
                        var pointIndex = binSearchCmp(data[entryIndex], lastTime, cmpTimes);
                        if (cmpTimes(data[entryIndex][pointIndex], lastTime) <= 0) {
                            pointIndex++;
                        }
                        entries[index].end_time = lastTime;
                        var numgroups = entries[index].cached_data.length - entryIndex - 1;
                        for (var i = entryIndex + 1; i < data.length; i++) {
                            this.loadedData -= data[i].length;
                        }
                        data.splice(entryIndex + 1, numgroups);
                        var numpoints = data[entryIndex].length - pointIndex - 1;
                        data[entryIndex].splice(pointIndex, numpoints);
                        this.loadedData -= numpoints;
                        index++;
                    }
                    var excised = entries.splice(0, index);
                    for (var i = 0; i < excised.length; i++) {
                        this.loadedData -= getCacheEntryLength(excised[i]);
                    }
                }
            }
        }
    };
    
function cmpFirstTimes(entry1, entry2) {
    return cmpTimes(entry1[0], entry2[0]);
}

/* Reduce memory consumption by removing some cached data. STARTTIME and
   ENDTIME are in UTC (Universal Coord. Time) and represent the extent of the
   current view (so the presently viewed data is not erased). CURRPWE is the
   pointwidth at which the data is currently being viewed. If current memory
   consumption is less than THRESHOLD, nothing will happen; otherwise, memory
   comsumption is decreased to TARGET or lower. Returns true if memory
   consumption was decreased; otherwise, returns false. */
Cache.prototype.limitMemory = function (streams, startTime, endTime, currPWE, threshold, target) {
        if (this.loadedData < threshold) {
            return false;
        }
        var dataCache = this.dataCache;
        var loadedStreams = this.loadedStreams;
        var i, j, k;
        
        // Delete extra streams
        var uuid;
        var used;
        var pointwidth;
        for (uuid in dataCache) {
            if (dataCache.hasOwnProperty(uuid)) {
                used = false;
                for (i = 0; i < streams.length; i++) {
                    if (streams[i].uuid == uuid) {
                        used = true;
                        break;
                    }
                }
                if (!used) {
                    this.loadedData -= this.loadedStreams[uuid];
                    for (pointwidth in this.dataCache[uuid]) {
                        if (this.dataCache[uuid].hasOwnProperty(pointwidth)) {
                            for (i = 0; i < this.dataCache[uuid][pointwidth].length; i++) {
                                if (this.dataCache[uuid][pointwidth][i].cached_drawing.hasOwnProperty("graph")) {
                                    this.dataCache[uuid][pointwidth][i].cached_drawing.graph.dispose();
                                    delete this.dataCache[uuid][pointwidth][i].cached_drawing.graph;
                                }
                            }
                        }
                    }
                    delete this.dataCache[uuid];
                    delete this.loadedStreams[uuid];
                    if (this.lastTimes.hasOwnProperty(uuid)) {
                        delete this.lastTimes[uuid];
                    }
                }
            }
        }
        if (this.loadedData <= target) {
            return true;
        }
        
        // Delete extra point width caches, if deleting streams wasn't enough
        var cache;
        var pointwidth, pointwidths;
        var pwMap = {}; // Maps uuid to 2-element array containing sorted array of pointwidths, and index of current pointwidth (if it were in the sorted array)
        for (i = 0; i < streams.length; i++) {
            cache = dataCache[streams[i].uuid];
            pointwidths = [];
            for (pointwidth in cache) {
                if (pointwidth != currPWE && cache.hasOwnProperty(pointwidth)) {
                    pointwidths.push(pointwidth);
                }
            }
            pointwidths.sort(function (a, b) { return a - b; });
            j = binSearch(pointwidths, currPWE, function (x) { return x; });
            pwMap[streams[i].uuid] = [pointwidths, j];
        }
        var remaining = true; // There are still pointwidths to remove
        var pwdata, pwcount;
        while (remaining) {
            remaining = false;
            for (i = 0; i < streams.length; i++) {
                uuid = streams[i].uuid;
                pointwidths = pwMap[uuid][0];
                j = pwMap[uuid][1];
                if (pointwidths.length != 0) {
                    remaining = true;
                    if (j > pointwidths.length / 2) {
                        pointwidth = pointwidths.shift();
                        j--;
                    } else {
                        pointwidth = pointwidths.pop();
                    }
                    pwdata = dataCache[uuid][pointwidth];
                    pwcount = 0;
                    for (k = pwdata.length - 1; k >= 0; k--) {
                        pwcount += getCacheEntryLength(pwdata[k]);
                        if (pwdata[k].cached_drawing.hasOwnProperty("graph")) {
                            pwdata[k].cached_drawing.graph.dispose();
                            delete pwdata[k].cached_drawing.graph;
                        }
                    }
                    delete dataCache[uuid][pointwidth];
                    this.loadedData -= pwcount;
                    loadedStreams[uuid] -= pwcount;
                }
            }
            if (this.loadedData <= target) {
                return true;
            }
        }
        
        // Delete extra cache entries in the current pointwidth, if deleting streams and pointwidths was not enough
        for (i = 0; i < streams.length; i++) {
            pwdata = dataCache[streams[i].uuid][currPWE];
            pwcount = 0;
            for (j = pwdata.length - 1; j >= 0; j--) {
                if ((cmpTimes(pwdata[j].start_time, startTime) <= 0 && cmpTimes(pwdata[j].end_time, endTime) >= 0) || (cmpTimes(pwdata[j].start_time, startTime) >= 0 && cmpTimes(pwdata[j].start_time, endTime) <= 0) || (cmpTimes(pwdata[j].end_time, startTime) >= 0 && cmpTimes(pwdata[j].end_time, endTime) <= 0)) {
                    continue; // This is the cache entry being displayed; we won't delete it
                }
                pwcount += getCacheEntryLength(pwdata[j]);
                if (pwdata[j].cached_drawing.hasOwnProperty("graph")) {
                    pwdata[j].cached_drawing.graph.dispose();
                    delete pwdata[j].cached_drawing.graph;
                }
                pwdata.splice(j, 1);
            }
            this.loadedData -= pwcount;
            loadedStreams[streams[i].uuid] -= pwcount;
            if (this.loadedData <= target) {
                return true;
            }
        }
        
        // Delete all but displayed data, if deleting streams, pointwidths, and cache entries was not enough
        for (i = 0; i < streams.length; i++) {
            pwdata = dataCache[streams[i].uuid][currPWE][0].cached_data;
            this.loadedData -= pwdata.length;
            loadedStreams[streams[i].uuid] -= pwdata.length; // this should be 0 now
            j = binSearchCmp(pwdata, startTime, cmpTimes);
            k = binSearchCmp(pwdata, endTime, cmpTimes);
            if (cmpTimes(pwdata[j], startTime) >= 0 && j > 0) {
                j--;
            }
            if (cmpTimes(pwdata[k], endTime) <= 0 && k < pwdata.length - 1) {
                k++;
            }
            if (dataCache[streams[i].uuid][currPWE][0].cached_drawing.hasOwnProperty("graph")) {
                dataCache[streams[i].uuid][currPWE][0].cached_drawing.graph.dispose();
                delete dataCache[streams[i].uuid][currPWE][0].cached_drawing.graph;
            }
            dataCache[streams[i].uuid][currPWE][0] = new CacheEntry([pwdata[j][0], pwdata[j][1]], [pwdata[k][0], pwdata[k][1]], pwdata.slice(j, k));
            loadedStreams[streams[i].uuid] += (k - j);
            this.loadedData += (k - j);
        }
        
        // If target is still less than loadedData, it means that target isn't big enough to accomodate the data that needs to be displayed on the screen
        return true;
    };
 
/** Create a geometry and shader so that the data can be drawn quickly. */   
function cacheDrawing(cacheEntry) {
    var graph = new THREE.Geometry();
    var data = cacheEntry.cached_data;
    var vertexID = 0;
    var vertexVect;
    var timeNanos = [];
    var normals = [];
    var shader;
    var i, j, k;
    var prevI, prevK;
    for (k = 0; k < data.length; k++) {
        for (i = 0; i < data[k].length; i++) {
            // The x and z coordinates are unused, so we can put the relevent time components there instead of using attribute values
            vertexVect = new THREE.Vector3(Math.floor(data[k][i][0] / 1000000), data[k][i][3], data[k][i][0] % 1000000);

            for (j = 0; j < 4; j++) {
                // These are reference copies, but that's OK since it gets sent to the vertex shader
                graph.vertices.push(vertexVect);
                timeNanos.push(data[k][i][1]);
            }
            
            vertexID += 4;
            
            /*for (j = 0; j < 6; j++) {
                pvect = new THREE.Vector3(x, y, 0);
                pvect.add(transforms[j]);
                points.vertices.push(pvect);
            }
            
            pointID += 6;*/
            
            if (i == 0 && k == 0) {
                normals.push(new THREE.Vector3(0, 0, 1));
                normals.push(new THREE.Vector3(0, 0, 1));
            } else {
                tempTime = subTimes(data
                [k]
                [i]
                .slice(0, 2),
                data
                [prevK]
                [prevI]);
                normal = new THREE.Vector3(1000000 * tempTime[0] + tempTime[1], data[k][i][3] - data[prevK][prevI][3], 0);
                // Again, reference copies are OK because it gets sent to the vertex shader
                normals.push(normal);
                normals.push(normal.clone());
                normals.push(normal);
                normals.push(normals[vertexID - 5]);
                normals[vertexID - 5].negate();

                
                // It seems that faces only show up if you traverse their vertices counterclockwise
                graph.faces.push(new THREE.Face3(vertexID - 6, vertexID - 5, vertexID - 4));
                graph.faces.push(new THREE.Face3(vertexID - 4, vertexID - 5, vertexID - 3));
                
                /*points.faces.push(new THREE.Face3(pointID - 3, pointID - 5, pointID - 4));
                points.faces.push(new THREE.Face3(pointID - 3, pointID - 6, pointID - 5));
                points.faces.push(new THREE.Face3(pointID - 3, pointID - 1, pointID - 6));
                points.faces.push(new THREE.Face3(pointID - 3, pointID - 2, pointID - 1));*/
            }
            prevI = i;
            prevK = k;
        }
    }
    
    shader = new THREE.ShaderMaterial({
        uniforms: {
            "affineMatrix": {type: 'm4'},
            "rot90Matrix": {type: 'm3'},
            "thickness": {type: 'f'},
            "yDomainLo": {type: 'f'},
            "xDomainLo1000": {type: 'f'},
            "xDomainLoMillis": {type: 'f'},
            "xDomainLoNanos": {type: 'f'}
            },
        attributes: {
            "normalVector": {type: 'v3', value: normals},
            "timeNanos": {type: 'f', value: timeNanos}
            },
        vertexShader: " \
            uniform mat4 affineMatrix; \
            uniform mat3 rot90Matrix; \
            uniform float thickness; \
            uniform float yDomainLo; \
            uniform float xDomainLo1000; \
            uniform float xDomainLoMillis; \
            uniform float xDomainLoNanos; \
            attribute vec3 normalVector; \
            attribute float timeNanos; \
            void main() { \
                float xDiff = 1000000000000.0 * (position.x - xDomainLo1000) + 1000000.0 * (position.z - xDomainLoMillis) + (timeNanos - xDomainLoNanos); \
                vec3 truePosition = vec3(xDiff, position.y - yDomainLo, 0.0); \
                vec4 newPosition = affineMatrix * vec4(truePosition, 1.0) + vec4(thickness * normalize(rot90Matrix * mat3(affineMatrix) * normalVector), 0.0); \
                gl_Position = projectionMatrix * modelViewMatrix * newPosition; \
             } \
             ",
        fragmentShader: "\
             void main() { \
                 gl_FragColor = vec4(0.0, 0.0, 1.0, 1.0); \
             } \
             "
    });
    
    graph.verticesNeedUpdate = true;
    graph.elementsNeedUpdate = true;
    normals.push(new THREE.Vector3(0, 0, 1));
    normals.push(new THREE.Vector3(0, 0, 1));
    
    cacheEntry.cached_drawing.graph = graph;
    cacheEntry.cached_drawing.normals = normals;
    cacheEntry.cached_drawing.timeNanos = timeNanos;
    cacheEntry.cached_drawing.shader = shader;
}

function removeFromSecCache(entry) {
    entry.inSecondaryCache = false;
    if (entry.cached_drawing.hasOwnProperty("graph") && !entry.inPrimaryCache) {
        freeDrawing(entry);
    }
}

function freeDrawing(entry) {
    entry.cached_drawing.graph.dispose();
    delete entry.cached_drawing.graph;
}

function getCacheEntryLength(entry) {
    var length = 0;
    for (var i = 0; i < entry.cached_data.length; i++) {
        length += entry.cached_data[i].length;
    }
    return length;
}
