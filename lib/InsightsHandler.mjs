// lib/InsightsHandler.mjs

import { EventEmitter } from "events";
import Queue from "./Queue.mjs";

export default class InsightsHandler extends EventEmitter {
  constructor(options) {
    super();
    options = options || {};
    this.log = options.log || console.log;
    this.homey = options.homey;
    this._api = options.api;
    this._logs = [];
    this._runQueue = new Queue({
      homey: this.homey,
      initHandler: this._initExport.bind(this),
      runHandler: this._runQueueHandler.bind(this),
      log: this.log,
    });
    this._abort = false;
  }

  isExporting() {
    return this._runQueue.isRunning();
  }

  _clearSchedule() {
    if (this._timeoutExport) {
      this.homey.clearTimeout(this._timeoutExport);
      this._timeoutExport = undefined;
    }
  }

  scheduleExport(interval = 600) {
    // Default: every 10 minutes
    this._clearSchedule();
    if (this._abort) return;
    this._timeoutExport = this.homey.setTimeout(this._onExport.bind(this), interval * 1000);
  }

  _onExport() {
    try {
      this._clearSchedule();
      if (this._abort || this.isExporting()) return;
      this._enqueueExportLogsCpu("lastHour"); // CPU export
      this._enqueueExportLogsMemory("lastHour"); // Memory export
    } finally {
      this.scheduleExport();
    }
  }

  /**
   * Enqueue export jobs instead of directly processing them.
   */
  async _enqueueExportLogsCpu(resolution) {
    this._runQueue.enQueue({ exportType: "cpu", resolution: resolution });
  }

  async _enqueueExportLogsMemory(resolution) {
    this._runQueue.enQueue({ exportType: "memory", resolution: resolution });
  }

  /**
   * Handle queue processing based on exportType.
   */
  async _runQueueHandler(item) {
    if (this._abort) return;
    try {
      this.log(`Export of ${item.exportType} started`);
      this.emit("export.started", {
        exportType: item.exportType,
        resolution: item.resolution,
      });

      if (item.exportType === "cpu") {
        await this._processExportLogsCpu(item.resolution);
      } else if (item.exportType === "memory") {
        await this._processExportLogsMemory(item.resolution);
      }
      if (this._abort) return;

      this.log(`Export of ${item.exportType} ended`);
      this.emit("export.ended", {
        exportType: item.exportType,
        resolution: item.resolution,
      });
    } catch (err) {
      this.log(`Export of ${item.exportType} failed`, err);
    }
  }

  stopExport() {
    this._abort = true;
    this._clearSchedule();
    this._runQueue.flushQueue();
  }

  async _initExport() {
    try {
      this._logs = Object.values(await this._api.insights.getLogs());
      if (this._logs && this._logs.length > 0) {
        this.log(`Get logs: ${this._logs.length}`);
        // Optionally, log the first few logs for inspection
        this._logs.slice(0, 5).forEach((log, index) => {
          // this.log(`Log ${index + 1}:`, JSON.stringify(log));
        });
      } else {
        this.log("No logs fetched from insights.");
      }
    } catch (err) {
      this._logs = [];
      this.log("initExport failed", err);
    }
  }

  /**
   * Helper function to fetch installed app IDs.
   * @returns {Promise<Set<string>>} A set containing the IDs of installed apps.
   */
  async _getInstalledAppIds() {
    try {
      const apps = await this._api.apps.getApps(); // This returns an object
      // this.log("getApps() response:", JSON.stringify(apps, null, 2));

      // Extract app IDs using Object.keys
      const appIds = new Set(Object.keys(apps));
     this.log(`Fetched ${appIds.size} installed app IDs.`);
      return appIds;
    } catch (err) {
      this.log("Failed to fetch installed apps:", err);
      return new Set(); // Return an empty set on failure
    }
  }

  /**
   * Process CPU logs.
   */
  async _processExportLogsCpu(resolution) {
    if (!this._logs || this._logs.length === 0) {
        this.log('No logs available for CPU export');
        return;
    }
    this.log(`Processing CPU logs with resolution: ${resolution}`);

    // Fetch installed app IDs
    const installedAppIds = await this._getInstalledAppIds();
    //this.log(`Installed app IDs: ${Array.from(installedAppIds).join(', ')}`);

    // Fetch the number of CPU cores
    const systemInfo = await this._api.system.getInfo();
    const cpuCount = systemInfo.cpus?.length;
    if (!cpuCount) throw new Error('CPU core count is unavailable');
    this.log(`Number of CPU cores: ${cpuCount}`);

    const events = [];
    const logs = Object.values(this._logs)
        .filter(log => 
            log.ownerUri === `homey:manager:apps` &&
            typeof log.ownerId === 'string' && log.ownerId.endsWith('-cpu') &&
            (log.type === 'number' || log.type === 'boolean')
        );

    this.log(`Filtered CPU logs: ${logs.length}`);

    for (let log of logs) {
        if (this._abort) return;
        const theAppId = log.ownerId.substring(0, log.ownerId.length - 4);

        // Check if the app is still installed
        if (!installedAppIds.has(theAppId)) {
            this.log(`Skipping export for uninstalled app: ${theAppId}`);
            continue; // Skip processing for this app
        }

        const pos = log.title.indexOf(' — ');
        const theAppName = pos >= 0 ? log.title.substring(0, pos) : theAppId;
        let entries;
        try {
            entries = await this._api.insights.getLogEntries({
                uri: log.ownerUri,
                id: log.id,
                resolution,
                $timeout: 10000
            });
        } catch (err) {
            this.log(`Failed to get log entries for ${theAppId} (${log.ownerId}):`, err);
            continue; // Skip to the next log
        }

        if (Array.isArray(entries?.values) && entries.values.length > 0) {
            // Idle samples are part of the average; missing and non-finite values are not.
            const validEntries = entries.values.filter(entry => Number.isFinite(entry.v) && entry.v >= 0);

            if (validEntries.length > 0) {
                // Compute the average CPU usage
                const sum = validEntries.reduce((acc, entry) => acc + entry.v, 0);
                const averageCpuUsage = sum / validEntries.length;

                // Calculate CPU percentage relative to total CPU capacity
                const averageCpuPercentage = (averageCpuUsage / cpuCount) * 100;

                events.push({
                    name: `app:homey:app:${theAppId}`,
                    tags: ['cpu', `${theAppId}`, `${theAppName}`],
                    fields: {
                        cpu: Math.round(averageCpuPercentage * 100) / 100
                    },
                    ts: new Date() // Use current timestamp
                });
            } else {
                this.log(`No valid CPU entries found for ${theAppId}`);
            }
        } else {
            this.log(`No CPU entries found for ${theAppId}`);
        }
    }

    if (this._abort) return;
    if (events.length === 0) {
        this.log('No CPU events to export.');
    } else {
        this.log(`Exporting ${events.length} CPU average events.`);
        events.forEach((event, index) => {
            this.log(`[${index}]: ${event.name} = ${JSON.stringify(event.fields)}`);
        });
        await this.homey.app.writeEvents(events);
    }
}


  /**
   * Process Memory logs.
   */
  async _processExportLogsMemory(resolution) {
    if (!this._logs || this._logs.length === 0) {
      this.log("No logs available for Memory export");
      return;
    }
    this.log(`Processing Memory logs with resolution: ${resolution}`);

    // Fetch installed app IDs
    const installedAppIds = await this._getInstalledAppIds();
    // this.log(`Installed app IDs: ${Array.from(installedAppIds).join(", ")}`);

    const events = [];
    const logs = Object.values(this._logs).filter(
      (log) =>
        log.ownerUri === `homey:manager:apps` && typeof log.ownerId === 'string' &&
        log.ownerId.endsWith("-mem") && (log.type === "number" || log.type === "boolean")
    );

    this.log(`Filtered Memory logs: ${logs.length}`);

    for (let log of logs) {
      if (this._abort) return;
      const theAppId = log.ownerId.substring(0, log.ownerId.length - 4);

      // Check if the app is still installed
      if (!installedAppIds.has(theAppId)) {
        this.log(`Skipping export for uninstalled app: ${theAppId}`);
        continue; // Skip processing for this app
      }

      const pos = log.title.indexOf(" — ");
      const theAppName = pos >= 0 ? log.title.substring(0, pos) : theAppId;
      let entries;
      try {
        entries = await this._api.insights.getLogEntries({
          uri: log.ownerUri,
          id: log.id,
          resolution,
          $timeout: 10000,
        });
      } catch (err) {
        this.log(`Failed to get log entries for ${theAppId} (${log.ownerId}):`, err);
        continue; // Skip to the next log
      }

      const validEntries = Array.isArray(entries?.values)
        ? entries.values.filter(entry => Number.isFinite(entry.v) && entry.v >= 0) : [];
      if (validEntries.length > 0) {
        // Compute the average Memory usage
        const sum = validEntries.reduce((acc, entry) => acc + entry.v, 0);
        const averageMemory = sum / validEntries.length;

        events.push({
          name: `app:homey:app:${theAppId}`,
          tags: ["memory_used", `${theAppId}`, `${theAppName}`],
          fields: {
            memory_used: Math.round(averageMemory * 100) / 100,
          },
          ts: new Date(), // Use current timestamp or entries.values[0].t
        });
      } else {
        this.log(`No Memory entries found for ${theAppId}`);
      }
    }

    if (this._abort) return;
    if (events.length === 0) {
      this.log("No Memory events to export.");
    } else {
      this.log(`Exporting ${events.length} Memory average events.`);
      events.forEach((event, index) => {
        this.log(`[${index}]: ${event.name} = ${JSON.stringify(event.fields)}`);
      });
      await this.homey.app.writeEvents(events);
    }
  }

  destroy() {
    this.stopExport();
    this._runQueue.destroy();
  }
}
