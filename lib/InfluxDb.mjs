import { EventEmitter } from 'events';
import http from 'http.min';
import * as escape from './escape.mjs';

const MESSAGES_SHALL_WRITE = 1000;
const MESSAGES_BUFFERED_MAX = 2000;

export default class InfluxDb extends EventEmitter {

    constructor(options) {
        super();
        options = options || {};
        this.log = options.log || console.log;
        this.homey = options.homey;
        this._write_interval = 10;
        this._measurements = [];
        this._counter = 0;
        this._connected = false;
        this._settingsVersion = 0;
        this._destroyed = false;
        this._dropped = 0;
    }

    async initialize(options) {
        await this.updateSettings(options);
    }

    getStatus() {
        return {
            url: this._host && this._host.length > 0 ? `${this._protocol}://${this._host}:${this._port}` : '',
            database: this._database,
            connected: this._connected,
            measurements: this._counter,
            buffered: this._measurements.length,
            dropped: this._dropped
        }
    }

    async updateSettings(options) {
        this._settingsVersion += 1;
        this._host = options.host;
        this._protocol = options.protocol || 'http';
        this._port = options.port || '8086';
        this._organization = options.organization || '';
        this._token = options.token || '';
        this._username = options.username || 'root';
        this._password = options.password || 'root';
        this._database = options.database;
        this._connected = false;
        this._isV2 = this._organization && this._organization.length > 0 && this._token && this._token.length > 0;
    }

    updateWriteInterval(write_interval) {
        write_interval = Number(write_interval);
        if (!Number.isFinite(write_interval) || write_interval < 10 || write_interval > 60) {
            throw new Error("Invalid write interval");
        }
        this._write_interval = write_interval;
        if (this._timeoutWriteToInfluxDb && !this._isWriting) this.scheduleWriteToInfluxDb();
    }

    write(measurement) {
        if (!measurement || this._destroyed) return false;
        try {
            this._toBody([measurement]);
        } catch (err) {
            this._dropped += 1;
            this.log('InfluxDb: invalid measurement skipped:', err.message);
            return false;
        }
        if (this._measurements.length >= MESSAGES_BUFFERED_MAX) {
            this._dropped += 1;
            if (this._dropped === 1 || this._dropped % 100 === 0) {
                this.log(`InfluxDb: buffer full; ${this._dropped} measurements dropped`);
            }
            return false;
        }
        this._measurements.push(measurement);
        if (this._measurements.length === MESSAGES_SHALL_WRITE && !this._retryPending) {
            void this._onWriteToInfluxDb();
        }
        return true;
    }

    _hostDefined() {
        return this._host && this._host.length > 0 &&
            this._database && this._database.length > 0;
    }

    async _pingDatabase(host, protocol, port, token) {
        return this._isV2 ? await this._pingDatabaseV2(host, protocol, port, token) :
            await this._pingDatabaseV1(host, protocol, port);
    }

    async _pingDatabaseV1(host, protocol, port) {
        let result;
        try {
            result = await http.get({
                uri: `${protocol}://${host}:${port}/ping`,
                timeout: 5000
            });
        } catch (err) {
            throw new Error(`InfluxDb ping failed (${err.code || err.message})`);
        }
        if (!result || !result.response) {
            throw new Error(`Missing response from ${protocol}://${host}:${port}`);
        }
        if (result.response.statusCode !== 204) {
            throw new Error(`InfluxDb at ${protocol}://${host}:${port} is not online! (${result.response.statusCode})`);
        }
    }

    async _pingDatabaseV2(host, protocol, port, token) {
        try {
            await this._pingDatabaseV1(host, protocol, port);
            return;
        } catch (err) {
            // Continue to ping V2
        }
        let result;
        try {
            result = await http.get({
                uri: `${protocol}://${host}:${port}/health`,
                timeout: 5000,
                json: true,
                headers: {
                    'Authorization': `Token ${token}`
                }
            });
        } catch (err) {
            throw new Error(`InfluxDb health check failed (${err.code || err.message})`);
        }
        if (!result || !result.response) {
            throw new Error(`No response from ${host}:${port}`);
        }
        if (result.response.statusCode === 200) {
            const data = result.data;
            if (data.status !== 'pass') {
                throw new Error(`InfluxDb at ${host}:${port} is not online!`);
            }
        } else {
            throw new Error(`InfluxDb at ${host}:${port} is not online!`);
        }
    }

    async _createInfluxDb() {
        const version = this._settingsVersion;
        try {
            if (!this._hostDefined()) {
                this.log('InfluxDb: missing host / database', this._host);
            } else {
                try {
                    await this._pingDatabase(this._host, this._protocol, this._port, this._token);
                    if (version !== this._settingsVersion || this._destroyed) return;
                    if (!this._isV2) {
                        const names = await this._getDatabaseNamesV1();
                        if (version !== this._settingsVersion || this._destroyed) return;
                        if (!names.includes(this._database)) {
                            await this._createDatabaseV1(this._database);
                        }
                    }
                    if (version !== this._settingsVersion || this._destroyed) return;
                    return true;
                } catch (err) {
                    this.log('InfluxDb: connection failed:', err.message);
                }
            }
        } catch (err) {
            this.log('createInfluxDb error', err);
        }
        return false;
    };

    async _createQueryV1(query) {
        const result = await http.post({
            uri: `${this._protocol}://${this._host}:${this._port}/query`,
            timeout: 10000,
            json: true,
            query: {
                u: this._username,
                p: this._password
            },
        }, `q=${encodeURIComponent(query)}`);
        if (result?.response?.statusCode !== 200) {
            throw new Error(`InfluxDb query failed (HTTP ${result?.response?.statusCode || 'missing response'})`);
        }
        if (result.data?.error || !Array.isArray(result.data?.results) ||
            result.data.results.some(item => item.error)) {
            throw new Error('InfluxDb query failed: server returned a query error or invalid result');
        }
        return result;
    }

    async _getDatabaseNamesV1() {
        const result = await this._createQueryV1('SHOW DATABASES');
        return (result.data.results[0]?.series?.[0]?.values || []).map(val => val[0]);
    }

    async _createDatabaseV1(database) {
        await this._createQueryV1(`CREATE DATABASE ${escape.quoted(database)}`);
    }

    _clearSchedule() {
        if (this._timeoutWriteToInfluxDb) {
            this.homey.clearTimeout(this._timeoutWriteToInfluxDb);
            this._timeoutWriteToInfluxDb = undefined;
        }
    }

    scheduleWriteToInfluxDb() {
        this._clearSchedule();
        if (this._destroyed) return;
        this._timeoutWriteToInfluxDb = this.homey.setTimeout(this._onWriteToInfluxDb.bind(this), this._write_interval * 1000);
    }

    async _onWriteToInfluxDb() {
        if (this._isWriting || this._destroyed) {
            return;
        }
        const version = this._settingsVersion;
        try {
            this._isWriting = true;
            this._clearSchedule();
            if (this._measurements.length > 0) {
                const available = await this._checkInfluxDbConnection();
                if (version !== this._settingsVersion || this._destroyed) return;
                this._retryPending = !available;
                if (available) {
                    // Keep in-flight points in the bounded buffer until acknowledged.
                    const measurements = this._measurements.slice();
                    const start = Date.now();
                    await this._writePoints(measurements);
                    this._measurements.splice(0, measurements.length);
                    this._counter += measurements.length;
                    this._retryPending = false;
                    if (version === this._settingsVersion && !this._destroyed && !this._connected) {
                        this._connected = true;
                        this.emit('online');
                    }
                    this.log(`InfluxDb: ${measurements.length} measurements written  (${Date.now() - start} ms)`);
                }
            }
        } catch (err) {
            this._retryPending = true;
            if (version === this._settingsVersion && !this._destroyed && this._connected) {
                this._connected = false;
                this.emit('offline');
            }
            this.log('InfluxDb write failed; buffered measurements retained:', err.code || err.message);
        } finally {
            this.scheduleWriteToInfluxDb();
            this._isWriting = false;
        }
    }

    async writeMeasurements(measurements) {
        for (const measurement of measurements) this.write(measurement);
    }

    _toBody(measurements) {
        return measurements
            .map(({measurement, tags = {}, fields, timestamp}) => {
                if (typeof measurement !== 'string' || !measurement || measurement.startsWith('#') ||
                    measurement.endsWith('\\') || /[\r\n]/.test(measurement) ||
                    !fields || !Object.keys(fields).length) throw new Error('Invalid measurement name or fields');
                let cntr = 0;
                const tagEntries = Array.isArray(tags) ? tags.map(tag => [`tag_${cntr++}`, tag]) : Object.entries(tags || {});
                const tagsString = tagEntries.filter(([, value]) => value !== undefined && value !== null && value !== '')
                    .map(([key, value]) => {
                        if (!key || key.endsWith('\\') || String(value).endsWith('\\') ||
                            /[\r\n]/.test(key + value)) throw new Error('Invalid tag');
                        return `,${escape.tag(key)}=${escape.tag(String(value).replace(/\u00A0/g, ' '))}`;
                    }).join('');

                const fieldsString = Object.keys(fields)
                    .map(fieldKey => {
                        const value = fields[fieldKey];
                        if (!fieldKey || fieldKey.endsWith('\\') || /[\r\n]/.test(fieldKey) ||
                            !(typeof value === 'boolean' || Number.isFinite(value) ||
                              (typeof value === 'string' && /^"(?:[^"\\\r\n]|\\["\\])*"$/.test(value)))) {
                            throw new Error('Invalid field key or value');
                        }
                        return `${escape.tag(fieldKey)}=${value}`;
                    })
                    .join(',');

                if (timestamp !== undefined && timestamp !== null) {
                    timestamp = timestamp instanceof Date ? timestamp.getTime() : timestamp;
                    if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid timestamp');
                    timestamp = ' ' + timestamp;
                } else timestamp = '';

                return `${escape.measurement(measurement)}${tagsString} ${fieldsString}${timestamp}`;
            })
            .join('\n');
    }

    async _writePoints(measurements) {
        const result = await (this._isV2 ? this._writePointsV2(measurements) : this._writePointsV1(measurements));
        const status = result?.response?.statusCode;
        if (status !== 204) throw new Error(`InfluxDb write rejected (HTTP ${status || 'missing response'})`);
        return result;
    }

    _writePointsV1(measurements) {
        const body = this._toBody(measurements);
        return http.post({
            uri: `${this._protocol}://${this._host}:${this._port}/write`,
            timeout: 10000,
            query: {
                db: this._database,
                u: this._username,
                p: this._password,
                precision: 'ms'
            },
            headers: {
                'content-type': 'text/plain; charset=utf-8'
            }
        }, body);
    }

    _writePointsV2(measurements) {
        const body = this._toBody(measurements);
        return http.post({
            uri: `${this._protocol}://${this._host}:${this._port}/api/v2/write`,
            timeout: 10000,
            query: {
                orgID: this._organization,
                bucket: this._database,
                precision: 'ms'
            },
            headers: {
                'content-type': 'text/plain; charset=utf-8',
                'Authorization': `Token ${this._token}`
            }
        }, body);
    }

    async _checkInfluxDbConnection() {
        if (!this._hostDefined()) {
            this.log('InfluxDb: host is not defined');
            return false;
        }
        if (!this._connected) {
            return this._createInfluxDb();
        }
        const version = this._settingsVersion;
        let online = false;
        try {
            await this._pingDatabase(this._host, this._protocol, this._port, this._token);
            online = true;
        } catch (err) {
            this.log('_checkInfluxDbConnection', err);
            online = false;
        }
        if (version !== this._settingsVersion || this._destroyed) return;
        if (this._connected && !online) {
            this._connected = false;
            this.log('InfluxDb: is marked as "offline"');
            this.emit('offline');
        }
        return online;
    }

    destroy() {
        this._destroyed = true;
        this._clearSchedule();
    }

};
