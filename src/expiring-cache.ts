import TinyQueue, * as tinyqueue from 'tinyqueue';

interface Expirable {
    readonly expirationTimeSeconds: number;
}

const expirableComparator: tinyqueue.Comparator<Expirable> =
    (a: Expirable, b: Expirable) => {
        if (a.expirationTimeSeconds < b.expirationTimeSeconds) {
            return -1;
        } else if (a.expirationTimeSeconds === b.expirationTimeSeconds) {
            return 0;
        } else {
            return 1;
        }
    };

class ExpiringCacheEntry<K, V> implements Expirable {

    constructor(
        readonly key: K,
        readonly value: V,
        readonly expirationTimeSeconds: number) {

    }

    expired(nowSeconds: number): boolean {
        return nowSeconds >= this.expirationTimeSeconds;
    }

}

export interface Stats {
    hits: number,
    misses: number,
    mapSize: number,
    queueSize: number
};

export default class ExpiringCache<K, V> {

    private readonly map = new Map<K, ExpiringCacheEntry<K, V>>();

    private readonly priorityQueue = new TinyQueue<ExpiringCacheEntry<K, V>>([], expirableComparator);

    private hits: number = 0;

    private misses: number = 0;

    add(key: K, value: V, expirationTimeSeconds: number) {
        const cacheEntry = new ExpiringCacheEntry(key, value, expirationTimeSeconds);
        this.map.set(key, cacheEntry);
        this.priorityQueue.push(cacheEntry);
    }

    get(key: K): V | undefined {
        let value: V | undefined;
        const mapEntry = this.map.get(key);
        if (mapEntry) {
            ++this.hits;
            value = mapEntry.value;
        } else {
            ++this.misses;
        }
        return value;
    }

    delete(key: K) {
        this.map.delete(key);
    }

    periodicCleanUp(nowSeconds: number): number {
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
            } else {
                done = true;
            }
        }

        return expiredEntries;
    }

    get mapSize(): number {
        return this.map.size;
    }

    get queueSize(): number {
        return this.priorityQueue.length;
    }

    get stats(): Stats {
        return {
            hits: this.hits,
            misses: this.misses,
            mapSize: this.mapSize,
            queueSize: this.queueSize
        };
    }

}
