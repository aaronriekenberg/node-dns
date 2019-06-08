import TinyQueue from 'tinyqueue';

export interface ExpiringCacheValue<K> {
    expired(nowSeconds: number): boolean;

    getExpirationTimeSeconds(): number;

    getCacheKey(): K
}

export class ExpiringCache<K, V extends ExpiringCacheValue<K>> {

    private readonly map = new Map<K, V>();

    private readonly priorityQueue = new TinyQueue<V>([], (a: V, b: V) => {
        if (a.getExpirationTimeSeconds() < b.getExpirationTimeSeconds()) {
            return -1;
        } else if (a.getExpirationTimeSeconds() === b.getExpirationTimeSeconds()) {
            return 0;
        } else {
            return 1;
        }
    });

    add(value: V) {
        this.map.set(value.getCacheKey(), value);
        this.priorityQueue.push(value);
    }

    get(key: K): V | undefined {
        return this.map.get(key);
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
                const mapObject = this.map.get(queueObject.getCacheKey());
                // validate expired cache object has not been re-added to map
                if (mapObject && mapObject.expired(nowSeconds)) {
                    this.map.delete(mapObject.getCacheKey());
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

}
