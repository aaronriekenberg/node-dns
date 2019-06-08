"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const tinyqueue_1 = __importDefault(require("tinyqueue"));
class ExpiringCache {
    constructor() {
        this.map = new Map();
        this.priorityQueue = new tinyqueue_1.default([], (a, b) => {
            if (a.getExpirationTimeSeconds() < b.getExpirationTimeSeconds()) {
                return -1;
            }
            else if (a.getExpirationTimeSeconds() === b.getExpirationTimeSeconds()) {
                return 0;
            }
            else {
                return 1;
            }
        });
    }
    add(value) {
        this.map.set(value.getCacheKey(), value);
        this.priorityQueue.push(value);
    }
    get(key) {
        return this.map.get(key);
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
                const mapObject = this.map.get(queueObject.getCacheKey());
                // validate expired cache object has not been re-added to map
                if (mapObject && mapObject.expired(nowSeconds)) {
                    this.map.delete(mapObject.getCacheKey());
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
}
exports.ExpiringCache = ExpiringCache;
