import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import http from 'http.min';
import InfluxDb from '../lib/InfluxDb.mjs';
import DeviceHandler from '../lib/DeviceHandler.mjs';
import HomeyStateHandler from '../lib/HomeyStateHandler.mjs';
import InsightsHandler from '../lib/InsightsHandler.mjs';
import Queue from '../lib/Queue.mjs';
import * as measurementsUtil from '../lib/measurementsUtil.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const response = (statusCode, data = {}) => ({ response: { statusCode }, data });
const point = value => ({ measurement: 'sensor', fields: { value }, timestamp: 1234 });
const quiet = () => {};

function fakeHomey() {
    const homey = new EventEmitter();
    const timers = new Map();
    let id = 0;
    homey.setTimeout = (callback, ms) => { timers.set(++id, { callback, ms }); return id; };
    homey.clearTimeout = timer => timers.delete(timer);
    homey.timers = timers;
    homey.fire = async () => {
        const [key, timer] = timers.entries().next().value;
        timers.delete(key);
        await timer.callback();
        await tick();
    };
    homey.app = { writeEvents: async () => {} };
    return homey;
}

describe('InfluxDb delivery and protocol', function () {
    let db, homey, get, post;
    beforeEach(async function () {
        homey = fakeHomey();
        db = new InfluxDb({ homey, log: quiet });
        await db.initialize({ host: 'example.invalid', database: 'metrics', organization: 'org', token: 'test-token' });
        get = http.get;
        post = http.post;
        http.get = async () => response(204);
        http.post = async () => response(204);
    });
    afterEach(function () { db.destroy(); http.get = get; http.post = post; });

    for (const status of [400, 401, 403, 404, 413, 422, 429, 500, 503]) {
        it(`retains rejected HTTP ${status} writes without counting them`, async function () {
            http.post = async () => response(status, 'sensitive server response');
            const original = point(0);
            db.write(original);
            await db._onWriteToInfluxDb();
            assert.equal(db.getStatus().measurements, 0);
            assert.equal(db.getStatus().connected, false);
            assert.deepEqual(db._measurements, [original]);
            http.post = async () => response(204);
            await db._onWriteToInfluxDb();
            assert.equal(db.getStatus().measurements, 1);
            assert.equal(db._measurements.length, 0);
        });
    }

    it('serializes slow writes and retains arrival order across a network failure', async function () {
        const pending = deferred();
        let requests = 0;
        http.post = () => { requests++; return pending.promise; };
        db.write(point(1));
        const write = db._onWriteToInfluxDb();
        await tick();
        db.write(point(2));
        await db._onWriteToInfluxDb();
        assert.equal(requests, 1);
        assert.equal(db._isWriting, true);
        pending.reject(new Error('ECONNRESET'));
        await write;
        let body;
        http.post = async (options, data) => { body = data; return response(204); };
        await db._onWriteToInfluxDb();
        assert.equal(body, 'sensor value=1 1234\nsensor value=2 1234');
        assert.equal(db.getStatus().measurements, 2);
    });

    it('emits online only after acknowledgement and does not flap on repeated authorization failures', async function () {
        const events = [];
        db.on('online', () => events.push('online'));
        db.on('offline', () => events.push('offline'));
        db.write(point(1));
        http.post = async () => response(401);
        await db._onWriteToInfluxDb();
        await db._onWriteToInfluxDb();
        assert.deepEqual(events, []);
        http.post = async () => response(204);
        await db._onWriteToInfluxDb();
        db.write(point(2));
        http.post = async () => response(401);
        await db._onWriteToInfluxDb();
        await db._onWriteToInfluxDb();
        assert.deepEqual(events, ['online', 'offline']);
        http.post = async () => response(204);
        await db._onWriteToInfluxDb();
        assert.deepEqual(events, ['online', 'offline', 'online']);
    });

    it('buffers Insights events while offline and retries without an event-driven storm', async function () {
        let calls = 0;
        http.get = async () => { calls++; throw new Error('offline'); };
        await db.writeMeasurements([point(1), point(2)]);
        await db._onWriteToInfluxDb();
        const checks = calls;
        for (let i = 0; i < 2500; i++) db.write(point(i));
        await tick();
        assert.equal(calls, checks);
        assert.equal(db.getStatus().buffered, 2000);
        assert.equal(db.getStatus().dropped, 502);
        assert.equal(homey.timers.size, 1);
    });

    it('includes in-flight points in the buffer limit', async function () {
        const pending = deferred();
        http.post = () => pending.promise;
        db.write(point(1));
        const write = db._onWriteToInfluxDb();
        await tick();
        for (let i = 0; i < 2100; i++) db.write(point(i));
        assert.equal(db.getStatus().buffered, 2000);
        assert.equal(db.getStatus().dropped, 101);
        pending.resolve(response(204));
        await write;
        assert.equal(db.getStatus().buffered, 1999);
    });

    it('does not restart its timer after destruction during a request', async function () {
        const pending = deferred();
        http.post = () => pending.promise;
        db.write(point(1));
        const write = db._onWriteToInfluxDb();
        await tick();
        db.destroy();
        pending.resolve(response(204));
        await write;
        assert.equal(homey.timers.size, 0);
        assert.equal(db.write(point(2)), false);
    });

    it('does not use a stale connection check after settings change', async function () {
        const pending = deferred();
        http.get = () => pending.promise;
        let writes = 0;
        http.post = async () => { writes++; return response(204); };
        db.write(point(1));
        const write = db._onWriteToInfluxDb();
        await tick();
        await db.updateSettings({ host: 'new.invalid', database: 'new' });
        pending.resolve(response(204));
        await write;
        assert.equal(writes, 0);
        assert.equal(db.getStatus().connected, false);
        assert.equal(db.getStatus().buffered, 1);
    });

    it('does not emit online when v1 database discovery or creation fails', async function () {
        await db.updateSettings({ host: 'example.invalid', database: 'metrics' });
        let online = 0;
        db.on('online', () => online++);
        http.post = async () => response(401);
        await db._checkInfluxDbConnection();
        assert.equal(online, 0);
        http.post = async () => response(200, { results: [{ error: 'authorization failed' }] });
        await db._checkInfluxDbConnection();
        assert.equal(online, 0);
        http.post = async (options, body) => body.includes('SHOW')
            ? response(200, { results: [{}] }) : response(200, { results: [{ error: 'denied' }] });
        await db._checkInfluxDbConnection();
        assert.equal(online, 0);
        assert.equal(db.getStatus().connected, false);
    });

    it('encodes v1 database queries as form values and uses one initial ping', async function () {
        const database = 'metrics & "other"';
        await db.updateSettings({ host: 'example.invalid', database });
        let pings = 0;
        const bodies = [];
        http.get = async () => { pings++; return response(204); };
        http.post = async (options, body) => { bodies.push(new URLSearchParams(body)); return response(200, { results: [{}] }); };
        assert.equal(await db._checkInfluxDbConnection(), true);
        assert.equal(pings, 1);
        assert.equal(bodies.length, 2);
        assert.equal(bodies[1].size, 1);
        assert.equal(bodies[1].get('q'), 'CREATE DATABASE "metrics & \\"other\\""');
        assert.equal(db.getStatus().connected, false);
    });

    it('sets an unambiguous line-protocol content type for both supported APIs', async function () {
        const seen = [];
        http.post = async options => { seen.push(options); return response(204); };
        await db._writePoints([point(1)]);
        await db.updateSettings({ host: 'example.invalid', database: 'metrics' });
        await db._writePoints([point(2)]);
        for (const options of seen) {
            assert.equal(options.headers['content-type'], 'text/plain; charset=utf-8');
            assert.equal(options.headers['Content-Type'], undefined);
            assert.equal(options.query.precision, 'ms');
        }
        assert.equal(seen[0].query.orgID, 'org');
        assert.equal(seen[1].query.db, 'metrics');
    });

    it('escapes field and tag keys, omits missing zones, and preserves epoch zero', function () {
        assert.equal(db._toBody([{
            measurement: 'sensor', tags: { zone: '', zoneId: null, missing: undefined, 'tag =': 12 },
            fields: { 'field =': false }, timestamp: 0,
        }]), 'sensor,tag\\ \\==12 field\\ \\==false 0');
        const formatted = measurementsUtil.fromValue('text', 'C:\\data\\"quoted"');
        assert.doesNotThrow(() => db._toBody([formatted]));
        assert.equal(formatted.fields.value, '"C:\\\\data\\\\\\"quoted\\""');
    });

    it('rejects invalid points without poisoning subsequent valid measurements', async function () {
        for (const value of [NaN, Infinity, -Infinity, null, undefined, 'unquoted']) db.write(point(value));
        db.write({ ...point(1), timestamp: new Date('invalid') });
        db.write({ ...point(1), measurement: 'bad\nline' });
        db.write(point(0));
        await db._onWriteToInfluxDb();
        assert.equal(db.getStatus().measurements, 1);
        assert.equal(db.getStatus().dropped, 8);
    });

    it('validates and reschedules the write interval', function () {
        for (const interval of ['bad', NaN, Infinity, 0, 9, 61]) assert.throws(() => db.updateWriteInterval(interval));
        db.scheduleWriteToInfluxDb();
        db.updateWriteInterval('30');
        assert.equal(homey.timers.size, 1);
        assert.equal([...homey.timers.values()][0].ms, 30000);
    });

    it('rejects comment lines and trailing identifier escapes before they can corrupt a batch', function () {
        for (const measurement of [
            { ...point(1), measurement: '#ignored' },
            { ...point(1), measurement: 'escaped\\' },
            { ...point(1), tags: { location: 'escaped\\' } },
            { ...point(1), tags: { 'escaped\\': 'location' } },
            { ...point(1), fields: { 'escaped\\': 1 } },
        ]) assert.equal(db.write(measurement), false);
        assert.equal(db.getStatus().buffered, 0);
        assert.equal(db.getStatus().dropped, 5);
    });
});

describe('measurement conversion', function () {
    it('handles optional percentage options and preserves finite zero values', function () {
        const capability = { name: 'dim', capId: 'dim', value: 0.5, capability: { units: '%', min: 0, max: 1 } };
        assert.equal(measurementsUtil.fromCapability(capability).fields.dim, 0.5);
        assert.equal(measurementsUtil.fromCapability(capability, { percentageScale: 'int' }).fields.dim, 50);
        assert.equal(measurementsUtil.fromValue('zero', 0).fields.value, 0);
        for (const value of [NaN, Infinity, -Infinity, 'a\nb', 'a\rb']) {
            assert.equal(measurementsUtil.fromValue('invalid', value), undefined);
        }
        assert.equal(measurementsUtil.fromEvent({ name: 'epoch', fields: { value: 0 }, ts: 0 }).timestamp, 0);
    });
});

function deviceFixture(id = 'device', caps = ['measure_temperature']) {
    const instances = [];
    const device = {
        id, name: 'Sensor', zone: 'zone', ready: true, capabilities: caps,
        capabilitiesObj: Object.fromEntries(caps.map(key => [key, { id: 'shared-base-id', type: 'number' }])),
        makeCapabilityInstance(key, listener) {
            const instance = { key, listener, destroyed: false, destroy() { this.destroyed = true; } };
            instances.push(instance);
            return instance;
        },
    };
    return { device, instances };
}

describe('device subscriptions', function () {
    let handler, api, homey;
    beforeEach(function () {
        homey = fakeHomey();
        api = { devices: new EventEmitter(), zones: new EventEmitter() };
        api.devices.getDevices = async () => ({});
        api.zones.getZones = async () => ({ zone: { id: 'zone', name: 'Kitchen' } });
        handler = new DeviceHandler({ api, homey, log: quiet });
    });
    afterEach(function () { handler.destroy(); });

    it('handles newly created devices, zone renames and the actual capability key', async function () {
        const { device, instances } = deviceFixture('new', ['measure_temperature.one', 'measure_temperature.two']);
        api.devices.getDevice = async () => device;
        await handler.registerDevices();
        api.devices.emit('device.create', device);
        await tick();
        assert.equal(instances.length, 2);
        assert.equal(handler._capabilityInstances.size, 2);
        api.zones.emit('zone.update', { id: 'zone', name: 'Renamed' });
        await tick();
        let event;
        handler.on('capability', value => { event = value; });
        const timestamp = new Date(1000);
        instances[1].listener(0, { lastChanged: timestamp });
        assert.equal(event.capId, 'measure_temperature.two');
        assert.equal(event.zoneName, 'Renamed');
        assert.equal(event.ts, timestamp);
        api.zones.emit('zone.delete', { id: 'zone' });
        await tick();
        instances[1].listener(1);
        assert.equal(event.zoneName, '');
    });

    it('cleans removed capabilities even when the API mutates its capabilities array', async function () {
        const { device, instances } = deviceFixture('device', ['one', 'two']);
        await handler._registerDevice(device);
        device.capabilities.splice(1, 1);
        assert.equal(handler._hasNodeChanged(device).changedDevice, true);
        await handler._registerDevice(device);
        assert.equal(instances[0].destroyed, true);
        assert.equal(instances[1].destroyed, true);
        assert.equal(handler._capabilityInstances.size, 1);
        handler.destroy();
        assert.equal(instances[2].destroyed, true);
        assert.equal(api.devices.listenerCount('device.update'), 0);
        assert.equal(api.zones.listenerCount('zone.update'), 0);
    });

    it('does not resurrect a deleted device after an outstanding fetch', async function () {
        const pending = deferred();
        const { device, instances } = deviceFixture();
        api.devices.getDevice = () => pending.promise;
        const update = handler._onDeviceUpdate(device);
        await handler._onDeviceDelete({ id: device.id });
        pending.resolve(device);
        await update;
        assert.equal(instances.length, 0);
    });

    it('contains rejected event fetches and tolerates null devices', async function () {
        api.devices.getDevice = async () => { throw new Error('temporary failure'); };
        api.devices.emit('device.update', { id: 'bad', ready: true });
        await tick();
        await handler._registerDevice(null);
        assert.equal(handler._nodes.size, 0);
    });

    it('does not replay a stale startup snapshot over a device deletion or zone rename', async function () {
        const zones = deferred();
        const devices = deferred();
        const { device, instances } = deviceFixture();
        api.zones.getZones = () => zones.promise;
        api.devices.getDevices = () => devices.promise;
        const registering = handler.registerDevices();
        api.zones.emit('zone.update', { id: 'zone', name: 'New name' });
        await tick();
        zones.resolve({ zone: { id: 'zone', name: 'Old name' } });
        await tick();
        api.devices.emit('device.delete', { id: device.id });
        await tick();
        devices.resolve({ device });
        await registering;
        assert.equal(handler._zones.get('zone').name, 'New name');
        assert.equal(instances.length, 0);
    });
});

describe('export queue lifecycle', function () {
    it('recovers after initialization and item failures', async function () {
        const homey = fakeHomey();
        let fail = true;
        const seen = [];
        const queue = new Queue({ homey, log: quiet,
            initHandler: async () => { if (fail) throw new Error('init'); },
            runHandler: async item => { seen.push(item); if (item === 0) throw new Error('item'); },
        });
        await queue.enQueue(1);
        await tick();
        assert.equal(queue.isRunning(), false);
        fail = false;
        await queue.enQueue(0);
        await queue.enQueue(2);
        await tick();
        await homey.fire();
        assert.deepEqual(seen, [0, 2]);
        assert.equal(queue.isRunning(), false);
        queue.destroy();
    });

    it('keeps single-worker ownership when flushed during a running handler', async function () {
        const pending = deferred();
        const homey = fakeHomey();
        const seen = [];
        const queue = new Queue({ homey, log: quiet, runHandler: async item => { seen.push(item); await pending.promise; } });
        await queue.enQueue(1);
        queue.flushQueue();
        await queue.enQueue(2);
        assert.deepEqual(seen, [1]);
        assert.equal(queue.isRunning(), true);
        queue.destroy();
        pending.resolve();
        await tick();
        assert.deepEqual(seen, [1]);
        assert.equal(homey.timers.size, 0);
    });

    it('cancels a sleeping worker on destruction', async function () {
        const homey = fakeHomey();
        const queue = new Queue({ homey, log: quiet, runHandler: async () => {} });
        const first = queue.enQueue(1);
        const second = queue.enQueue(2);
        await Promise.all([first, second]);
        await tick();
        assert.equal(homey.timers.size, 1);
        queue.destroy();
        await tick();
        assert.equal(homey.timers.size, 0);
        assert.equal(queue.isRunning(), false);
    });
});

describe('system and Insights metrics', function () {
    it('reports fresh zero free memory without requiring per-app types, plus Homey-only storage', async function () {
        const homey = fakeHomey();
        homey.app.systemInfo = { totalmem: 1, freemem: 1 };
        const api = { system: {
            getInfo: async () => ({ totalmem: 100, freemem: 0, loadavg: [0, 0, 0], cpus: [{ speed: 100, times: { idle: 1 } }] }),
            getStorageInfo: async () => ({ total: 200, free: 0, types: { app: { size: 5 } } }),
        } };
        const handler = new HomeyStateHandler({ homey, api, log: quiet });
        handler.appMetrics(false);
        const events = [];
        handler.on('state.changed', event => events.push(event));
        await handler._onUpdateData();
        assert.deepEqual(events.find(event => event.name === 'homey:memory').fields, { memory_total: 100, memory_free: 0, memory_swap: 0 });
        assert.equal(events.find(event => event.name === 'homey:storage').fields.storage_free, 0);
        assert.equal(events.some(event => event.name.startsWith('app:')), false);
        handler.destroy();
        assert.equal(homey.timers.size, 0);
    });

    it('does not overlap polls or emit stale data after destruction', async function () {
        const homey = fakeHomey();
        const pending = deferred();
        let calls = 0;
        const api = { system: {
            getInfo: () => { calls++; return pending.promise; },
            getStorageInfo: () => pending.promise,
        } };
        const handler = new HomeyStateHandler({ homey, api, log: quiet });
        const events = [];
        handler.on('state.changed', event => events.push(event));
        const poll = handler._onUpdateData();
        await handler._onUpdateData();
        assert.equal(calls, 1);
        handler.destroy();
        pending.resolve({});
        await poll;
        assert.deepEqual(events, []);
        assert.equal(homey.timers.size, 0);
    });

    function insightsFixture(values) {
        const homey = fakeHomey();
        const written = [];
        const requests = [];
        homey.app.writeEvents = async events => written.push(...events);
        const api = {
            apps: { getApps: async () => ({ sample: {} }) },
            system: { getInfo: async () => ({ cpus: [{}, {}] }) },
            insights: {
                getLogs: async () => ({ cpu: { ownerUri: 'homey:manager:apps', ownerId: 'sample-cpu', id: 'cpu', type: 'number', title: 'Sample' },
                    memory: { ownerUri: 'homey:manager:apps', ownerId: 'sample-mem', id: 'memory', type: 'number', title: 'Sample' } }),
                getLogEntries: async request => { requests.push(request); return { values }; },
            },
        };
        const handler = new InsightsHandler({ homey, api, log: quiet });
        return { handler, api, homey, written, requests };
    }

    it('uses the requested resolution and includes idle CPU samples', async function () {
        const { handler, written, requests } = insightsFixture([{ v: 0 }, { v: 1 }, { v: null }, { v: NaN }]);
        await handler._initExport();
        await handler._processExportLogsCpu('lastHour');
        await handler._processExportLogsMemory('lastHour');
        assert.equal(written[0].fields.cpu, 25);
        assert.equal(written[1].fields.memory_used, 0.5);
        assert.equal(requests.length, 2);
        for (const request of requests) {
            assert.equal(request.resolution, 'lastHour');
            assert.equal(request.limit, undefined);
            assert.equal(request.sort, undefined);
        }
        handler.destroy();
    });

    it('exports all-idle CPU as zero and suppresses results after disable', async function () {
        const { handler, api, written, homey } = insightsFixture([{ v: 0 }, { v: 0 }]);
        await handler._initExport();
        await handler._processExportLogsCpu('lastHour');
        assert.equal(written[0].fields.cpu, 0);
        const pending = deferred();
        api.insights.getLogEntries = () => pending.promise;
        const exporting = handler._processExportLogsMemory('lastHour');
        await tick();
        handler.destroy();
        pending.resolve({ values: [{ v: 20 }] });
        await exporting;
        assert.equal(written.length, 1);
        assert.equal(homey.timers.size, 0);
    });
});

describe('app and settings lifecycle with a mocked SDK', function () {
    function appFixture() {
        const homey = fakeHomey();
        const values = new Map([['homey_metrics', 'false']]);
        homey.settings = new EventEmitter();
        const translations = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
        homey.__ = key => key.split('.').reduce((value, part) => value[part], translations);
        homey.settings.get = key => values.get(key);
        homey.settings.set = (key, value) => { values.set(key, value); homey.settings.emit('set', key); };
        const cards = new Map();
        const getCard = id => ({ registerRunListener(listener) { cards.set(id, listener); }, trigger: async () => {} });
        homey.flow = { getConditionCard: getCard, getActionCard: getCard, getTriggerCard: getCard };
        const api = { devices: new EventEmitter(), zones: new EventEmitter(), insights: {}, system: {} };
        for (const manager of Object.values(api)) manager.connect = async () => {};
        api.system.getInfo = async () => ({ uptime: 1000 });
        api.devices.getDevices = async () => ({});
        api.zones.getZones = async () => ({});
        api.destroy = quiet;
        const context = { HomeyPkg: { App: class {} }, HomeyApiPkg: { HomeyAPI: { createAppAPI: async () => api } },
            measurementsUtil, HomeyStateHandler, DeviceHandler, InsightsHandler, InfluxDb };
        // Only replace module wiring; exercise the actual app methods against the fake SDK.
        const source = readFileSync(new URL('../app.mjs', import.meta.url), 'utf8')
            .replace(/^import .*;\r?\n/gm, '').replace('export default class InfluxDbApp', 'globalThis.AppClass = class InfluxDbApp');
        vm.runInNewContext(source, context);
        const app = new context.AppClass();
        app.homey = homey;
        app.log = quiet;
        homey.app = app;
        return { app, homey, api, cards, values };
    }

    it('initializes defaults, rejects invalid Flow values and preserves percentage scale on settings save', async function () {
        const { app, homey, cards, values } = appFixture();
        values.set('write_interval', 'invalid');
        values.set('percentage_scale', 'int');
        await app.onInit();
        assert.equal(app._running, true);
        assert.equal(app._influxDb._write_interval, 10);
        await assert.rejects(cards.get('write_number')({ measurement: 'bad', value: Infinity }), /invalid data/);
        await assert.rejects(cards.get('influxdb_write_interval')({ write_interval: 'bad' }), /Invalid write interval/);
        assert.equal(values.get('write_interval'), 10);
        homey.settings.set('settings', { host: 'example.invalid', database: 'db', measurement_mode: 'by_name' });
        await tick();
        assert.equal(app._measurementOptions.percentageScale, 'int');
        app._onUninstall();
        assert.equal(homey.timers.size, 0);
        assert.equal(homey.settings.listenerCount('set'), 0);
    });

    it('recovers a transient startup API failure without duplicate subscriptions', async function () {
        const { app, homey, api } = appFixture();
        let calls = 0;
        api.devices.connect = async () => { if (++calls === 1) throw new Error('not ready'); };
        await app.onInit();
        assert.equal(app._running, false);
        const retry = [...homey.timers.values()].find(timer => timer.ms === 30000);
        assert.ok(retry);
        await retry.callback();
        assert.equal(app._running, true);
        assert.equal(api.devices.listenerCount('device.update'), 1);
        app._onUninstall();
        assert.equal(homey.timers.size, 0);
    });

    it('marks settings ready even when loading a setting fails', async function () {
        const html = readFileSync(new URL('../settings/index.html', import.meta.url), 'utf8');
        const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(code => code.includes('function onHomeyReady'));
        const calls = [];
        const context = { document: { getElementById: () => ({ addEventListener: quiet, style: {} }) } };
        vm.runInNewContext(source, context);
        context.onHomeyReady({ ready: () => calls.push('ready'), get: (key, cb) => { calls.push('get'); cb(new Error('unavailable')); }, alert: message => calls.push(message) });
        await tick();
        assert.deepEqual(calls, ['ready', 'get', 'unavailable']);
    });

    it('stops startup cleanly while device enumeration is pending', async function () {
        const { app, homey, api } = appFixture();
        const pending = deferred();
        api.devices.getDevices = () => pending.promise;
        const startup = app.onInit();
        await tick();
        app._onUninstall();
        pending.resolve({});
        await startup;
        assert.equal(app._running, false);
        assert.equal(homey.timers.size, 0);
        assert.equal(api.devices.listenerCount('device.update'), 0);
    });

    it('bounds startup retries and prevents concurrent initialization', async function () {
        const { app, homey, api } = appFixture();
        const pending = deferred();
        let calls = 0;
        api.devices.connect = () => { calls++; return pending.promise; };
        const startup = app.onInit();
        await tick();
        await app.onStartup();
        assert.equal(calls, 1);
        pending.reject(new Error('offline'));
        await startup;
        for (let i = 1; i < 10; i++) await app.onStartup();
        assert.equal(calls, 10);
        assert.equal([...homey.timers.values()].some(timer => timer.ms >= 30000), false);
        app._onUninstall();
    });

    it('waits for a settings status response before polling again', async function () {
        const html = readFileSync(new URL('../settings/index.html', import.meta.url), 'utf8');
        const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(code => code.includes('function onHomeyReady'));
        const homey = fakeHomey();
        const elements = new Map();
        const context = { setTimeout: homey.setTimeout, clearTimeout: homey.clearTimeout,
            document: { getElementById: id => {
                if (!elements.has(id)) elements.set(id, { style: {}, addEventListener: quiet });
                return elements.get(id);
            } },
        };
        let callback, requests = 0;
        vm.runInNewContext(source, context);
        context.onHomeyReady({ ready: quiet, get: (key, cb) => cb(null, ''), alert: quiet,
            api: (method, path, body, cb) => { callback = cb; requests++; },
        });
        await tick();
        assert.equal(requests, 1);
        assert.equal(homey.timers.size, 0);
        callback(null, { running: true, influxDb: { url: 'example.invalid' } });
        assert.equal(homey.timers.size, 1);
        await homey.fire();
        assert.equal(requests, 2);
        assert.equal(homey.timers.size, 0);
    });
});
