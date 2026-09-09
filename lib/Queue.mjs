export default class Queue {

    constructor(options) {
        options = options || {};
        this.log = options.log || console.log;
        this.homey = options.homey;
        this.initHandler = options.initHandler;
        this.runHandler = options.runHandler;
        this.queue = [];
        this.queueRunning = false;
        this._destroyed = false;
    }

    isRunning() {
        return this.queueRunning;
    }

    async enQueue(item) {
        if (this._destroyed) return;
        this.queue.push(item);
        if (!this.queueRunning) {
            this.queueRunning = true;
            void this.runQueue();
        }
    }

    deQueue() {
        return this.queue.shift();
    }

    async runQueue() {
        try {
            if (this.initHandler) await this.initHandler();
            while (!this._destroyed && this.queue.length > 0) {
                const item = this.deQueue();
                try {
                    await this.runHandler(item);
                } catch (err) {
                    this.log('Queue item failed', err);
                }
                if (!this._destroyed && this.queue.length > 0) {
                    await new Promise(resolve => {
                        this._resume = resolve;
                        this._timeout = this.homey.setTimeout(resolve, 10000);
                    });
                    this._timeout = undefined;
                    this._resume = undefined;
                }
            }
        } catch (err) {
            this.log('Queue initialization failed', err);
            this.queue = [];
        } finally {
            this.queueRunning = false;
        }
    }

    flushQueue() {
        this.queue = [];
        if (this._timeout) this.homey.clearTimeout(this._timeout);
        if (this._resume) this._resume();
        // The active handler retains ownership until it settles.
    }

    destroy() {
        this._destroyed = true;
        this.flushQueue();
    }

}
