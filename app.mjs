import HomeyPkg from "homey";
import HomeyApiPkg from "homey-api";
import { delay } from "./lib/util.mjs";
import * as measurementsUtil from "./lib/measurementsUtil.mjs";
import HomeyStateHandler from "./lib/HomeyStateHandler.mjs";
import DeviceHandler from "./lib/DeviceHandler.mjs";
import InsightsHandler from "./lib/InsightsHandler.mjs";
import InfluxDb from "./lib/InfluxDb.mjs";

// Destructure named exports from the default imports
const { App } = HomeyPkg;
const { HomeyAPI } = HomeyApiPkg;

export default class InfluxDbApp extends App {
  async onInit() {
    this._boundOnHomeyStateChanged = this._onHomeyStateChanged.bind(this);
    this._running = false;
    this.homey.on("unload", () => this._onUninstall());
    // Register Flow Cards first
    await this.initFlows();
    this.log("Flow Cards initialized.");

    await this.onStartup(); // Await onStartup to ensure proper sequencing
  }

  async onStartup() {
    try {
      await this.getApi();
      if (await this.shallWaitForHomey()) {
        await this.waitForHomey();
      }

      // Now Initialize InfluxDB
      this._influxDb = new InfluxDb({ homey: this.homey, log: this.log });
      this.log("InfluxDb instance created.");

      // Initialize InfluxDb asynchronously
      await this._influxDb.initialize({
        host: this.homey.settings.get("host"),
        protocol: this.homey.settings.get("protocol"),
        port: this.homey.settings.get("port"),
        organization: this.homey.settings.get("organization"),
        token: this.homey.settings.get("token"),
        username: this.homey.settings.get("username"),
        password: this.homey.settings.get("password"),
        database: this.homey.settings.get("database"),
      });
      this.log("InfluxDb initialized with settings.");

      // Attach event listeners after initialization
      this._influxDb.on("offline", this._onOffline.bind(this));
      this._influxDb.on("online", this._onOnline.bind(this));
      this.log("InfluxDb event listeners attached.");

      // Initialize Settings After InfluxDb
      await this.initSettings();
      this.log("Settings initialized.");

      // Initialize Flow Cards After InfluxDb and Settings
      // moved to OnInit due to the error Flow Card not registered (type: condition, id: is_online)
      // await this.initFlows();
      // this.log("Flow Cards initialized.");

      // Proceed with Device Handler Initialization
      this._devices = new DeviceHandler({ homey: this.homey, api: this._api, log: this.log });
      this._devices.on("capability", this._onCapability.bind(this));
      await this._devices.registerDevices();
      this.log("Devices registered.");

      // Enable or Disable Metrics as per Settings
      await this.enableDisableMetrics();
      this.log("Metrics enabled/disabled as per settings.");

      // Schedule InfluxDB Writes
      this._influxDb.scheduleWriteToInfluxDb();
      this.log("InfluxDb write scheduling initiated.");

      this._running = true;
      this.log("InfluxDbApp is running...");
    } catch (err) {
      this.log("onStartup error:", err);
    }
  }

  async initSettings() {
    const host = this.homey.settings.get("host");
    if (!host || host.length === 0) {
      this.homey.settings.set("host", "");
    }

    const protocol = this.homey.settings.get("protocol");
    if (!protocol || protocol.length === 0) {
      this.homey.settings.set("protocol", "http");
    }

    const port = this.homey.settings.get("port");
    if (!port || port.length === 0) {
      this.homey.settings.set("port", "8086");
    }

    const organization = this.homey.settings.get("organization");
    if (!organization || organization.length === 0) {
      this.homey.settings.set("organization", "");
    }

    const token = this.homey.settings.get("token");
    if (!token || token.length === 0) {
      this.homey.settings.set("token", "");
    }

    const username = this.homey.settings.get("username");
    if (!username || username.length === 0) {
      this.homey.settings.set("username", "root");
    }

    const password = this.homey.settings.get("password");
    if (!password || password.length === 0) {
      this.homey.settings.set("password", "root");
    }

    const database = this.homey.settings.get("database");
    if (!database || database.length === 0) {
      this.homey.settings.set("database", "homey");
    }

    // Handle measurement_mode
    let measurementMode = this.homey.settings.get("measurement_mode");
    if (measurementMode === undefined || measurementMode === null) {
      measurementMode = "by_name";
      this.homey.settings.set("measurement_mode", measurementMode);
    }

    // Handle measurement_prefix
    let measurementPrefix = this.homey.settings.get("measurement_prefix");
    if (measurementPrefix === undefined || measurementPrefix === null) {
      measurementPrefix = "";
      this.homey.settings.set("measurement_prefix", measurementPrefix);
    }

    // Handle homey_metrics
    const homey_metrics = this.homey.settings.get("homey_metrics");
    if (homey_metrics === null || homey_metrics === undefined) {
      this.homey.settings.set("homey_metrics", "homey");
    } else if (homey_metrics === false) {
      this.homey.settings.set("homey_metrics", "false");
    }

    // Handle write_interval
    let write_interval = this.homey.settings.get("write_interval");
    if (!write_interval) {
      write_interval = 10;
      this.homey.settings.set("write_interval", write_interval);
    }

    // Handle percentage_scale
    let percentageScale = this.homey.settings.get("percentage_scale");
    if (!percentageScale) {
      percentageScale = "default"; // Options: 'int', 'float', 'default'
      this.homey.settings.set("percentage_scale", percentageScale);
    }

    // Update measurement options to include percentageScale
    this._measurementOptions = {
      measurementMode: measurementMode,
      measurementPrefix: measurementPrefix,
      percentageScale: percentageScale,
    };

    // Listen for settings changes
    this.homey.settings.on("set", this._onSettingsChanged.bind(this));

    // Update InfluxDb settings
    await this._influxDb.updateSettings({
      host: this.homey.settings.get("host"),
      protocol: this.homey.settings.get("protocol"),
      port: this.homey.settings.get("port"),
      organization: this.homey.settings.get("organization"),
      token: this.homey.settings.get("token"),
      username: this.homey.settings.get("username"),
      password: this.homey.settings.get("password"),
      database: this.homey.settings.get("database"),
    });

    // Update write interval
    this._influxDb.updateWriteInterval(write_interval);
  }

  async _onSettingsChanged(key) {
    this.log("Settings changed", key);
    if (key === "settings") {
      const settings = this.homey.settings.get("settings");

      // Update various settings
      this.homey.settings.set("host", settings.host);
      this.homey.settings.set("protocol", settings.protocol);
      this.homey.settings.set("port", settings.port);
      this.homey.settings.set("organization", settings.organization);
      this.homey.settings.set("token", settings.token);
      this.homey.settings.set("username", settings.username);
      this.homey.settings.set("password", settings.password);
      this.homey.settings.set("database", settings.database);
      this.homey.settings.set("measurement_mode", settings.measurement_mode);
      this.homey.settings.set("measurement_prefix", settings.measurement_prefix);

      // Handle percentage_scale
      if (settings.percentage_scale) {
        this.homey.settings.set("percentage_scale", settings.percentage_scale);
      }

      // Update InfluxDb settings
      await this._influxDb.updateSettings(settings);

      // Update measurement options to include percentageScale
      this._measurementOptions = {
        measurementMode: settings.measurement_mode,
        measurementPrefix: settings.measurement_prefix,
        percentageScale: settings.percentage_scale || "default", // Provide a fallback if necessary
      };
    }
  }

  async shallWaitForHomey() {
    const uptime = (await this._api.system.getInfo()).uptime;
    return uptime < 600;
  }

  async waitForHomey() {
    let numDevices = 0;
    let attempts = 0;
    const maxAttempts = 50;
    while (attempts < maxAttempts) {
      let currentDevices = Object.keys(await this._api.devices.getDevices()).length;
      if (currentDevices === numDevices) {
        break;
      }
      numDevices = currentDevices;
      attempts++;
      await delay(this.homey, 120 * 1000);
    }
    if (attempts === maxAttempts) {
      this.log("waitForHomey: Reached maximum attempts without stabilizing device count.");
    }
  }

  async initFlows() {
    try {
      this.homey.flow.getConditionCard("is_online").registerRunListener((args, state) => {
        this.log('Flow Card "is_online" triggered');
        return this._influxDb ? this._influxDb.getStatus().connected : false;
      });
      this.log('Flow Card "is_online" registered successfully');

      this.homey.flow
        .getConditionCard("is_metrics_enabled")
        .registerRunListener((args, state) => this.homey.settings.get("homey_metrics") !== "false");
      this.log('Flow Card "is_metrics_enabled" registered successfully');

      this.homey.flow
        .getConditionCard("is_app_metrics_enabled")
        .registerRunListener((args, state) => this.homey.settings.get("homey_metrics") === "true");
      this.log('Flow Card "is_app_metrics_enabled" registered successfully');

      this.homey.flow.getActionCard("enable_metrics").registerRunListener(async (args, state) => {
        this.homey.settings.set("homey_metrics", args.enabled);
        await this.enableDisableMetrics();
      });
      this.log('Action Card "enable_metrics" registered successfully');

      this.homey.flow.getActionCard("influxdb_write_interval").registerRunListener(async (args, state) => {
        this.homey.settings.set("write_interval", args.write_interval);
        this._influxDb.updateWriteInterval(args.write_interval);
      });
      this.log('Action Card "influxdb_write_interval" registered successfully');

      this.homey.flow
        .getActionCard("write_boolean")
        .registerRunListener(async (args, state) => this.writeFromValue(args.measurement, args.value));
      this.log('Action Card "write_boolean" registered successfully');

      this.homey.flow
        .getActionCard("write_number")
        .registerRunListener(async (args, state) => this.writeFromValue(args.measurement, args.value));
      this.log('Action Card "write_number" registered successfully');

      this.homey.flow
        .getActionCard("write_text")
        .registerRunListener(async (args, state) => this.writeFromValue(args.measurement, args.value));
      this.log('Action Card "write_text" registered successfully');
    } catch (error) {
      this.log("Error registering Flow Cards:", error);
    }
  }

  async getApi() {
    if (!this._api) {
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey, debug: false });
      await this._api.system.connect();
      await this._api.devices.connect();
      await this._api.zones.connect();
      await this._api.insights.connect();
    }
    return this._api;
  }

  async getStatus() {
    return {
      running: this._running,
      influxDb: this._influxDb ? this._influxDb.getStatus() : {},
    };
  }

  async homeyState(enabled, appMetrics) {
    if (enabled) {
      if (!this._homey) {
        this._homey = new HomeyStateHandler({ homey: this.homey, api: this._api, log: this.log });
        this._homey.on("state.changed", this._boundOnHomeyStateChanged);
        this._homey.scheduleFetchState();
      }
      this._homey.appMetrics(appMetrics);
    } else {
      if (this._homey) {
        this._homey._clearSchedule();
        this._homey.removeListener("state.changed", this._boundOnHomeyStateChanged);
        //delete this._homey;
        this._homey = null;
      }
    }
  }

  async insights(enabled) {
    if (enabled) {
      if (!this._insights) {
        this._insights = new InsightsHandler({ homey: this.homey, api: this._api, log: this.log });
        this._insights.scheduleExport(60);
      }
    } else {
      if (this._insights) {
        this._insights._clearSchedule();
        //delete this._insights;
        this._insights = null;
      }
    }
  }

  async enableDisableMetrics() {
    const enabled = this.homey.settings.get("homey_metrics");
    const homeyMetrics = enabled === "true" || enabled === "homey";
    const appMetrics = enabled === "true";
    await this.homeyState(homeyMetrics, appMetrics);
    await this.insights(appMetrics);
    this.log(
      `Homey metrics: was ${homeyMetrics ? "enabled" : "disabled"}, App metrics: was ${appMetrics ? "enabled" : "disabled"}`
    );
  }

  async writeFromValue(measurement, value) {
    if (!this._influxDb) {
      return;
    }
    this._influxDb.write(measurementsUtil.fromValue(measurement, value, this._measurementOptions));
  }

  async writeEvents(events) {
    if (!this._influxDb) {
      return;
    }
    this._influxDb.writeMeasurements(measurementsUtil.fromEvents(events, this._measurementOptions));
  }

  _onUninstall() {
    try {
      if (this._insights) {
        this._insights._clearSchedule();
        this._insights = null;
      }
      if (this._homey) {
        this._homey._clearSchedule();
        this._homey.removeListener("state.changed", this._boundOnHomeyStateChanged);
        this._homey = null;
      }
      if (this._influxDb) {
        this._influxDb._clearSchedule();
        this._influxDb = null;
      }
      if (this._devices) {
        this._devices.unregisterDevices();
        this._devices = null;
      }
    } catch (err) {
      this.log("_onUninstall error", err);
    }
  }

  _onOffline(event) {
    this.homey.flow
      .getTriggerCard("offline")
      .trigger()
      .catch((err) => this.log(err));
  }

  _onOnline(event) {
    this.homey.flow
      .getTriggerCard("online")
      .trigger()
      .catch((err) => this.log(err));
  }

  _onHomeyStateChanged(event) {
    if (!this._influxDb) {
      return;
    }
    this._influxDb.write(measurementsUtil.fromEvent(event, this._measurementOptions));
  }

  _onCapability(capability) {
    if (!this._influxDb) {
      return;
    }
    this._influxDb.write(measurementsUtil.fromCapability(capability, this._measurementOptions));
  }
}
