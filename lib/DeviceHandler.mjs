'use strict';

import { EventEmitter } from 'events';

export default class DeviceHandler extends EventEmitter {

    constructor(options) {
        super();
        options = options || {};
        this.log = options.log || console.log;
        this.homey = options.homey;
        this._api = options.api;
        this._nodes = new Map();
        this._zones = new Map();
        this._capabilityInstances = new Map();
        this._deviceUpdates = new Map();
        this._destroyed = false;
        this._listeners = [
            [this._api.devices, 'device.create', this._onDeviceUpdate],
            [this._api.devices, 'device.update', this._onDeviceUpdate],
            [this._api.devices, 'device.delete', this._onDeviceDelete],
            [this._api.zones, 'zone.create', this._onZoneCreate],
            [this._api.zones, 'zone.update', this._onZoneUpdate],
            [this._api.zones, 'zone.delete', this._onZoneDelete],
        ].map(([manager, event, handler]) => {
            const listener = data => Promise.resolve().then(() => {
                if (!this._destroyed) return handler.call(this, data);
            }).catch(err => this.log(`${event} failed`, err));
            manager.on(event, listener);
            return [manager, event, listener];
        });
    }

    async _onDeviceUpdate(deviceUpdated) {
        this._initialDeviceEvents?.add(deviceUpdated?.id);
        if (!deviceUpdated?.id || deviceUpdated.ready === false || this._destroyed) {
            return;
        }
        const request = {};
        this._deviceUpdates.set(deviceUpdated.id, request);
        const { changedDevice } = this._hasNodeChanged(deviceUpdated);
        if (changedDevice) {
            //this.log('Updated device', deviceUpdated.id, deviceUpdated.name, deviceUpdated.capabilities);
            const device = await this._api.devices.getDevice({ id: deviceUpdated.id });
            if (this._destroyed || this._deviceUpdates.get(deviceUpdated.id) !== request) return;
            await this._registerDevice(device);
        }
    }

    _hasNodeChanged(device) {
        const node = this._nodes.get(device.id);
        let changedDevice = !this._nodes.has(device.id) ||
            node && node.name !== device.name ||
            node && node.zone !== device.zone ||
            node && (!Array.isArray(device.capabilities) ||
                node.capabilities.slice().sort().join(",") !== device.capabilities.slice().sort().join(","));
        return { node, changedDevice };
    }

    async _onDeviceDelete(deviceDeleted) {
        this._initialDeviceEvents?.add(deviceDeleted.id);
        this._deviceUpdates.delete(deviceDeleted.id);
        this.log('Remove device', deviceDeleted.id);
        this._unregisterDevice(deviceDeleted.id);
    }

    async _onZoneCreate(id) {
        this.log('Zone added', id);
        await this._getAndRegisterZone(id);
    }

    async _onZoneUpdate(id) {
        this.log('Zone updated', id);
        await this._getAndRegisterZone(id);
    }

    async _getAndRegisterZone(zone) {
        this._initialZoneEvents?.add(zone?.id);
        if (zone?.id && !this._destroyed) await this._registerZone(zone);
    }

    async _onZoneDelete(zoneId) {
        zoneId = typeof zoneId === 'object' ? zoneId.id : zoneId;
        this._initialZoneEvents?.add(zoneId);
        this.log('Zone deleted', zoneId);
        if (!this._zones.has(zoneId)) {
            return;
        }
        this._zones.delete(zoneId);
        //this.log('Zone deleted', zoneId);
    }

    async registerDevices() {
        this.log("Register devices");
        this._initialZoneEvents = new Set();
        const zones = await this._api.zones.getZones();
        if (zones && !this._destroyed) {
            for (const zone of Object.values(zones)) {
                if (!this._initialZoneEvents.has(zone.id)) await this._registerZone(zone);
            }
        }
        this._initialZoneEvents = undefined;
        if (this._destroyed) return;
        this._initialDeviceEvents = new Set();
        const devices = await this._api.devices.getDevices();
        if (devices) {
            for (let key in devices) {
                const device = devices[key];
                if (!this._initialDeviceEvents.has(device?.id)) await this._registerDevice(device);
            }
            this.log('registerDevices', Object.getOwnPropertyNames(devices).length);
        }
        this._initialDeviceEvents = undefined;
    }

    _createNode(device) {
        const node = {
            id: device.id,
            name: device.name,
            zone: device.zone,
            capabilities: [...device.capabilities]
        };
        this._nodes.set(device.id, node);
        return node;
    }

    async _registerDevice(device) {
        if (this._destroyed) return;
        if (!device ||
            typeof device !== 'object' ||
            !device.id ||
            !device.name ||
            !Array.isArray(device.capabilities) ||
            !device.capabilitiesObj || typeof device.makeCapabilityInstance !== 'function') {
            this.log('Invalid device', device?.id);
            return;
        }

        this.log(`Register device: ${device.id} ${device.name}`);
        this._unregisterDevice(device.id);
        this._createNode(device);

        const capabilities = device.capabilitiesObj;
        for (let key in capabilities) {
            if (capabilities.hasOwnProperty(key)) {
                const capability = capabilities[key];
                if (capability && device.capabilities.includes(key) &&
                    (capability.type === 'number' || capability.type === 'boolean' || capability.type === 'enum')) {
                    this._registerCapability(device, capability, key);
                }
            }
        }
    }

    _registerCapability(device, capability, capabilityKey) {
        try {
            const deviceCapabilityId = JSON.stringify([device.id, capabilityKey]);
            this._destroyCapabilityInstance(deviceCapabilityId);
            const capabilityInstance = device.makeCapabilityInstance(capabilityKey, (value, instance) => {
                const node = this._nodes.get(device.id);
                if (!node || this._destroyed) return;
                let zone;
                if (node) {
                    zone = this._zones.get(node.zone);
                }
                this.emit('capability', {
                    id: device.id,
                    name: node.name,
                    zoneId: node ? node.zone : '',
                    zoneName: zone ? zone.name : '',
                    capability: capability,
                    capId: capabilityKey,
                    value: value,
                    ts: instance?.lastChanged || undefined
                });
            });
            this._capabilityInstances.set(deviceCapabilityId, capabilityInstance);
            this.log("Registered capability instance", device.name, capability.title, capability.type);
        } catch (e) {
            this.log("Error capability: " + capabilityKey, e);
        }
    }

    _destroyCapabilityInstance(deviceCapabilityId) {
        const capabilityInstance = this._capabilityInstances.get(deviceCapabilityId);
        if (capabilityInstance) {
            capabilityInstance.destroy();
            this._capabilityInstances.delete(deviceCapabilityId);
            this.log("Destroyed capability instance", deviceCapabilityId);
        }
    }

    unregisterDevices() {
        this.log("Unregister devices");
        for (var [id, node] of this._nodes.entries()) {
            try {
                this._unregisterDevice(id);
            } catch (e) {
                this.log('Failed to unregister device', id, e);
            }
        }
        this._nodes.clear();
    }

    _unregisterDevice(deviceId) {
        if (!this._nodes.has(deviceId)) {
            return;
        }

        const node = this._nodes.get(deviceId);
        const deviceCaps = node.capabilities;
        if (deviceCaps) {
            if (deviceCaps) {
                for (let capabilityId of deviceCaps) {
                    this._destroyCapabilityInstance(JSON.stringify([deviceId, capabilityId]));
                }
            }
        }

        this._nodes.delete(deviceId);
    }

    _createZone(zone) {
        const node = {
            id: zone.id,
            name: zone.name,
            parent: zone.parent
        };
        this._zones.set(zone.id, node);
    }

    async _registerZone(zone) {
        if (this._destroyed || !zone?.id) return;
        this.log(`Register zone: ${zone.id} ${zone.name}`);
        this._createZone(zone);
        return true;
    }

    destroy() {
        this._destroyed = true;
        for (const [manager, event, listener] of this._listeners) manager.off(event, listener);
        this._listeners = [];
        this.unregisterDevices();
        this._deviceUpdates.clear();
        this._zones.clear();
    }

};
