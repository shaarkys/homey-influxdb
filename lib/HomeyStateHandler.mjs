import { EventEmitter } from 'events';

export default class HomeyStateHandler extends EventEmitter {

    constructor(options) {
        super();
        options = options || {};
        this.log = options.log || console.log;
        this.homey = options.homey;
        this._api = options.api;
        this._appMetrics = true;
        this._destroyed = false;

        // Initialize previous storage data
        this._previousStorageInfo = {
            total: null,
            free: null,
            types: {}
        };

        // Initialize previous storage_used per app
        this._previousAppStorageUsed = {};

        // Set flush interval in milliseconds (default: 10 minutes)
        this._flushInterval = options.flushInterval || 10 * 60 * 1000;
        this._lastFlushTime = Date.now();
    }

    appMetrics(appMetrics) {
        this._appMetrics = appMetrics;
    }

    _clearSchedule() {
        if (this._timeoutFetchState) {
            this.homey.clearTimeout(this._timeoutFetchState);
            this._timeoutFetchState = undefined;
        }
    }

    scheduleFetchState(interval = 30) {
        this._clearSchedule();
        if (this._destroyed) return;
        this._timeoutFetchState = this.homey.setTimeout(this._onUpdateData.bind(this), interval * 1000);
    }

    async _onUpdateData() {
        if (this._destroyed || this._updating) return;
        this._updating = true;
        try {
            this._clearSchedule();
            await Promise.all([this._updateSystemData().then(() => this._updateMemoryData()), this._updateStorageData()]);
        } finally {
            this._updating = false;
            this.scheduleFetchState();
        }
    }

    async _updateSystemData() {
        try {
            this.homey.app.systemInfo = null;
            const systemInfo = await this._api.system.getInfo({ $timeout: 10000 });
            if (this._destroyed) return;
            this.homey.app.systemInfo = systemInfo; // Store systemInfo for later use
            this._onCpuLoadChanged({
                average_1: systemInfo.loadavg[0],
                average_5: systemInfo.loadavg[1],
                average_15: systemInfo.loadavg[2],
                cpu_speed: systemInfo.cpus[0].speed
            });
            for (let time in systemInfo.cpus[0].times) {
                if (systemInfo.cpus[0].times.hasOwnProperty(time)) {
                    this._onCpuTimesChanged({
                        field: `time_${time}`,
                        time: systemInfo.cpus[0].times[time]
                    });
                }
            }
        } catch (err) {
            this.log("Update system info failed", err);
        }
    }

    _onCpuLoadChanged(load) {
        if (this._destroyed) return;
        this.emit('state.changed', {
            name: 'homey:cpu_load',
            tags: ['cpu_load'],
            fields: load
        });
    }

    _onCpuTimesChanged(times) {
        if (this._destroyed) return;
        this.emit('state.changed', {
            name: 'homey:cpu_times',
            tags: ['cpu_times'],
            fields: {
                [times.field]: times.time
            }
        });
    }

    _updateMemoryData() {
        const systemInfo = this.homey.app.systemInfo;

        if (this._destroyed) return;
        if (systemInfo && Number.isFinite(systemInfo.freemem) && Number.isFinite(systemInfo.totalmem)) {
            try {
                // Emit memory overview
                this._onMemoryChanged({
                    memory_total: systemInfo.totalmem,
                    memory_free: systemInfo.freemem,
                    memory_swap: systemInfo.swapmem || 0, // Default to 0 if swapmem is undefined
                });

                // Emit memory usage per application if app metrics are enabled
                if (this._appMetrics && systemInfo.types) {
                    for (let app in systemInfo.types) {
                        if (systemInfo.types.hasOwnProperty(app)) {
                            this._onMemoryAppChanged({
                                app: app,
                                name: systemInfo.types[app].name,
                                memory_used: systemInfo.types[app].size
                            });
                        }
                    }
                }
            } catch (err) {
                this.log("Processing stored memory info failed", err);
            }
        } else {
            this.log("Update memory info failed: systemInfo not available or incomplete");
        }
    }


    _onMemoryChanged(memory_info) {
        if (this._destroyed) return;
        this.emit('state.changed', {
            name: 'homey:memory',
            tags: ['memory'],
            fields: memory_info
        });
    }

    _onMemoryAppChanged(memory_info) {
        if (this._destroyed || !this._appMetrics) return;
        this.emit('state.changed', {
            name: `app:${memory_info.app}`,
            tags: ['memory', `${memory_info.app}`, `${memory_info.name}`],
            fields: {
                memory_used: memory_info.memory_used
            }
        });
    }

    async _updateStorageData() {
        if (!this._destroyed) {
            try {
                const storageInfo = await this._api.system.getStorageInfo({ $timeout: 10000 });
                if (this._destroyed) return;
                const currentTime = Date.now();
                const timeSinceLastFlush = currentTime - this._lastFlushTime;
                const shouldFlush = timeSinceLastFlush >= this._flushInterval;

                // Emit storage_total and storage_free if they have changed or if it's time to flush
                const storageTotalChanged = this._previousStorageInfo.total !== storageInfo.total;
                const storageFreeChanged = this._previousStorageInfo.free !== storageInfo.free;

                if (storageTotalChanged || storageFreeChanged || shouldFlush) {
                    this._onStorageChanged({
                        storage_total: storageInfo.total,
                        storage_free: storageInfo.free
                    });

                    // Update previous storage total and free
                    this._previousStorageInfo.total = storageInfo.total;
                    this._previousStorageInfo.free = storageInfo.free;
                }

                // Iterate through each app to determine if storage_used has changed
                for (let app in storageInfo.types) {
                    if (this._appMetrics && storageInfo.types.hasOwnProperty(app)) {
                        const currentStorageUsed = storageInfo.types[app].size;
                        const previousStorageUsed = this._previousAppStorageUsed[app];

                        const hasChange = previousStorageUsed !== currentStorageUsed;
                        const shouldAppFlush = shouldFlush;

                        if (hasChange || shouldAppFlush) {
                            this._onStorageAppChanged({
                                app: app,
                                name: storageInfo.types[app].name,
                                storage_used: currentStorageUsed
                            });

                            // Update previous storage_used for the app
                            this._previousAppStorageUsed[app] = currentStorageUsed;
                        }
                    }
                }

                // Update last flush time if flush occurred
                if (shouldFlush) {
                    this._lastFlushTime = currentTime;
                }

            } catch (err) {
                this.log("Update storage info failed", err);
            }
        }
    }

    /**
     * Checks if the new storage information is different from the previous one.
     * @param {Object} newStorageInfo - The latest storage information fetched.
     * @returns {boolean} - Returns true if there's a change, false otherwise.
     */
    _hasStorageInfoChanged(newStorageInfo) {
        // This method is now deprecated as we've implemented per-app change detection
        // Retaining it for reference; consider removing if not needed
        return false;
    }

    _onStorageChanged(storage_info) {
        if (this._destroyed) return;
        this.emit('state.changed', {
            name: 'homey:storage',
            tags: ['storage'],
            fields: storage_info
        });
    }

    _onStorageAppChanged(storage_info) {
        if (this._destroyed || !this._appMetrics) return;
        this.emit('state.changed', {
            name: `app:${storage_info.app}`,
            tags: ['storage', `${storage_info.app}`, `${storage_info.name}`],
            fields: {
                storage_used: storage_info.storage_used
            }
        });
    }

    destroy() {
        this._destroyed = true;
        this._clearSchedule();
    }

};
