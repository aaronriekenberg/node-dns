import TinyQueue from 'tinyqueue';
const expirableComparator = (a, b) => {
    if (a.expirationTimeSeconds < b.expirationTimeSeconds) {
        return -1;
    }
    else if (a.expirationTimeSeconds === b.expirationTimeSeconds) {
        return 0;
    }
    else {
        return 1;
    }
};
class ExpiringCacheEntry {
    constructor(key, value, expirationTimeSeconds) {
        this.key = key;
        this.value = value;
        this.expirationTimeSeconds = expirationTimeSeconds;
    }
    expired(nowSeconds) {
        return nowSeconds >= this.expirationTimeSeconds;
    }
}
;
export default class ExpiringCache {
    constructor() {
        this.map = new Map();
        this.priorityQueue = new TinyQueue([], expirableComparator);
        this.hits = 0;
        this.misses = 0;
    }
    add(key, value, expirationTimeSeconds) {
        const cacheEntry = new ExpiringCacheEntry(key, value, expirationTimeSeconds);
        this.map.set(key, cacheEntry);
        this.priorityQueue.push(cacheEntry);
    }
    get(key) {
        let value;
        const mapEntry = this.map.get(key);
        if (mapEntry) {
            ++this.hits;
            value = mapEntry.value;
        }
        else {
            ++this.misses;
        }
        return value;
    }
    delete(key) {
        this.map.delete(key);
    }
    periodicCleanUp(nowSeconds) {
        let expiredEntries = 0;
        let done = false;
        while ((this.priorityQueue.length > 0) && (!done)) {
            const queueObject = this.priorityQueue.peek();
            if (queueObject && queueObject.expired(nowSeconds)) {
                this.priorityQueue.pop();
                const mapObject = this.map.get(queueObject.key);
                // validate expired cache object has not been re-added to map
                if (mapObject && mapObject.expired(nowSeconds)) {
                    this.map.delete(mapObject.key);
                    ++expiredEntries;
                }
            }
            else {
                done = true;
            }
        }
        return expiredEntries;
    }
    get mapSize() {
        return this.map.size;
    }
    get queueSize() {
        return this.priorityQueue.length;
    }
    get stats() {
        return {
            hits: this.hits,
            misses: this.misses,
            mapSize: this.mapSize,
            queueSize: this.queueSize
        };
    }
}
