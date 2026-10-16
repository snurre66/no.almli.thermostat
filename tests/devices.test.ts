import {describe, expect, it, vi} from 'vitest';
import {DeviceCalculator} from '../lib/DeviceCalculator';
import {Devices} from '../lib/Devices';
import {DeviceRequest, DeviceRequests, DeviceClass, DRIVER_VTHERMO} from '../lib/types';
import {Zones} from '../lib/Zones';
import {makeApiDevice, makeZone} from './helpers';

function request(values: Partial<DeviceRequest>): DeviceRequests {
    const requests = new DeviceRequests();
    requests.addRequest(Object.assign(new DeviceRequest(), values));
    return requests;
}

describe('Devices registry', () => {
    it('registers valid supported devices and ignores unavailable or unsupported ones', () => {
        const supported = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 20}});
        const unavailable = makeApiDevice({id: 'unavailable', capabilities: {measure_temperature: 20}});
        unavailable.available = false;
        const unsupported = makeApiDevice({id: 'unsupported', deviceClass: 'speaker', capabilities: {onoff: true}});
        const devices = new Devices({supported, unavailable, unsupported} as any);
        expect(devices.getDevices().map(device => device.id)).toEqual(['sensor']);
        expect(devices.validAndSupported(supported)).toBe(true);
        expect(devices.validAndSupported(unavailable)).toBe(false);
        expect(devices.validAndSupported(unsupported)).toBe(false);
    });

    it('accepts supported classes and temperature/alarm capabilities', () => {
        const devices = new Devices();
        expect(devices.validAndSupported(makeApiDevice({deviceClass: DeviceClass.fan}))).toBe(true);
        expect(devices.validAndSupported(makeApiDevice({deviceClass: DeviceClass.airconditioner}))).toBe(true);
        expect(devices.validAndSupported(makeApiDevice({deviceClass: DeviceClass.refrigerator}))).toBe(true);
        expect(
            devices.validAndSupported(makeApiDevice({deviceClass: 'other', capabilities: {measure_temperature: 20}})),
        ).toBe(true);
        expect(
            devices.validAndSupported(makeApiDevice({deviceClass: 'other', capabilities: {alarm_contact: false}})),
        ).toBe(true);
    });

    it('filters physical classes, virtual classes and app-specific virtual drivers correctly', () => {
        const physical = makeApiDevice({id: 'physical', deviceClass: DeviceClass.thermostat});
        const virtual = makeApiDevice({
            id: 'virtual',
            driverId: DRIVER_VTHERMO,
            deviceClass: DeviceClass.thermostat,
            capabilities: {target_temperature: 20},
        });
        const virtualHeater = makeApiDevice({
            id: 'virtual-heater',
            deviceClass: 'socket',
            virtualClass: DeviceClass.heater,
        });
        const devices = new Devices({physical, virtual, virtualHeater} as any);
        expect(devices.getDevices(DeviceClass.thermostat).map(device => device.id)).toEqual(['physical']);
        expect(devices.getDevices(DeviceClass.vthermo).map(device => device.id)).toEqual(['virtual']);
        expect(devices.getDevices(DeviceClass.heater).map(device => device.id)).toEqual(['virtual-heater']);
    });

    it('looks devices up by API id, local data id and zone', () => {
        const one = makeApiDevice({id: 'one', dataId: 'data-one', zone: 'one'});
        const two = makeApiDevice({id: 'two', zone: 'two'});
        const devices = new Devices({one, two} as any);
        expect(devices.getDevice('one')?.id).toBe('one');
        expect(devices.getDeviceByDataId('data-one')?.id).toBe('one');
        expect(devices.getDevicesFromZone('two')?.map(device => device.id)).toEqual(['two']);
        expect(devices.getDevicesFromZones([makeZone('one'), makeZone('two')])?.map(device => device.id)).toEqual([
            'one',
            'two',
        ]);
        expect(devices.getDevicesFromZones(undefined)).toBeUndefined();
    });

    it('detects active contact and motion alarms only on sensors in scope', () => {
        const contact = makeApiDevice({id: 'contact', zone: 'one', capabilities: {alarm_contact: true}});
        const motion = makeApiDevice({id: 'motion', zone: 'two', capabilities: {alarm_motion: true}});
        const nonSensor = makeApiDevice({
            id: 'other',
            zone: 'one',
            deviceClass: DeviceClass.heater,
            capabilities: {alarm_contact: true},
        });
        const devices = new Devices({contact, motion, nonSensor} as any);
        expect(devices.hasContactAlarm(makeZone('one'))).toBe(true);
        expect(devices.hasContactAlarm(makeZone('two'))).toBe(false);
        expect(devices.hasMotionAlarm([makeZone('one'), makeZone('two')])).toBe(true);
        expect(devices.hasMotionAlarm(undefined)).toBe(false);
    });

    it('updates by local data id only when changed and schedules an immediate calculation', () => {
        const api = makeApiDevice({
            id: 'virtual',
            dataId: 'data-id',
            driverId: DRIVER_VTHERMO,
            capabilities: {target_temperature: 20},
        });
        const logger = {debug: vi.fn(), warn: vi.fn(), info: vi.fn()};
        const calculator = {startCalculation: vi.fn()};
        const devices = new Devices({api} as any, undefined, logger);
        devices.setCalculator(calculator as any);
        devices.updateByDataId('data-id', 'target_temperature', 21);
        devices.updateByDataId('data-id', 'target_temperature', 21);
        devices.updateByDataId('missing', 'target_temperature', 21);
        expect(devices.getDevice('virtual')?.getLocalCapabilityValue('target_temperature').value).toBe(21);
        expect(calculator.startCalculation).toHaveBeenCalledTimes(1);
        expect(calculator.startCalculation).toHaveBeenCalledWith(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unknown device'));
    });

    it('updates mapped virtual-device settings immediately by local data id', () => {
        const api = makeApiDevice({
            id: 'virtual',
            dataId: 'data-id',
            driverId: DRIVER_VTHERMO,
            capabilities: {onoff: false},
        });
        api.settings = {onoff_enabled: false};
        const calculator = {startCalculation: vi.fn()};
        const devices = new Devices({api} as any);
        devices.setCalculator(calculator as any);

        devices.updateSettingsByDataId('data-id', {onoff_enabled: true});

        expect(devices.getDevice('virtual')?.deviceSettings?.onoffEnabled).toBe(true);
        expect(calculator.startCalculation).toHaveBeenCalledOnce();
        expect(calculator.startCalculation).toHaveBeenCalledWith(1);
    });

    it('subscribes to supported capabilities, reacts to changes and destroys subscriptions', () => {
        const callbacks = new Map<string, (value: unknown) => void>();
        const destroys: ReturnType<typeof vi.fn>[] = [];
        const api = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 20, onoff: false}});
        api.makeCapabilityInstance = vi.fn((id: string, callback: (value: unknown) => void) => {
            callbacks.set(id, callback);
            const destroy = vi.fn();
            destroys.push(destroy);
            return {destroy};
        });
        const calculator = {startCalculation: vi.fn()};
        const devices = new Devices({api} as any);
        devices.setCalculator(calculator as any);
        callbacks.get('measure_temperature')!(21);
        callbacks.get('measure_temperature')!(21);
        expect(devices.getDevice('sensor')?.getLocalCapabilityValue('measure_temperature').value).toBe(21);
        expect(calculator.startCalculation).toHaveBeenCalledTimes(1);
        devices.destroy();
        expect(destroys.every(destroy => destroy.mock.calls.length === 1)).toBe(true);
    });

    it('normalizes Fahrenheit capability events before updating the local model', () => {
        let listener!: (value: unknown) => void;
        const api = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 68}});
        api.capabilitiesObj.measure_temperature.units = '°F';
        api.makeCapabilityInstance = vi.fn((_id: string, callback: (value: unknown) => void) => {
            listener = callback;
            return {destroy: vi.fn()};
        });
        const calculator = {startCalculation: vi.fn()};
        const devices = new Devices({api} as any);
        devices.setCalculator(calculator as any);

        listener(77);

        expect(devices.getDevice('sensor')?.getLocalCapabilityValue('measure_temperature').value).toBe(25);
        expect(calculator.startCalculation).toHaveBeenCalledOnce();
    });

    it('replaces capability subscriptions when an API device is refreshed', () => {
        let firstListener!: (value: unknown) => void;
        let secondListener!: (value: unknown) => void;
        const firstDestroy = vi.fn();
        const secondDestroy = vi.fn();
        const first = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 20}});
        first.makeCapabilityInstance = vi.fn((_id: string, listener: (value: unknown) => void) => {
            firstListener = listener;
            return {destroy: firstDestroy};
        });
        const second = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 21}});
        second.makeCapabilityInstance = vi.fn((_id: string, listener: (value: unknown) => void) => {
            secondListener = listener;
            return {destroy: secondDestroy};
        });
        const calculator = {startCalculation: vi.fn()};
        const devices = new Devices({sensor: first} as any);
        devices.setCalculator(calculator as any);

        expect(firstListener).toBeTypeOf('function');
        devices.createOrUpdateDevice(second);
        expect(firstDestroy).toHaveBeenCalledOnce();
        expect(secondListener).toBeTypeOf('function');
        expect(devices.getDevice('sensor')?.getLocalCapabilityValue('measure_temperature').value).toBe(21);
        secondListener(22);
        expect(devices.getDevice('sensor')?.getLocalCapabilityValue('measure_temperature').value).toBe(22);
        expect(calculator.startCalculation).toHaveBeenCalledTimes(2);
    });

    it('destroys subscriptions for removed capabilities and snapshot devices', () => {
        const destroys = new Map<string, ReturnType<typeof vi.fn>>();
        const sensor = makeApiDevice({
            id: 'sensor',
            capabilities: {measure_temperature: 20, alarm_motion: false},
        });
        sensor.makeCapabilityInstance = vi.fn((id: string) => {
            const destroy = vi.fn();
            destroys.set(`sensor:${id}`, destroy);
            return {destroy};
        });
        const removed = makeApiDevice({id: 'removed', capabilities: {measure_temperature: 10}});
        removed.makeCapabilityInstance = vi.fn((id: string) => {
            const destroy = vi.fn();
            destroys.set(`removed:${id}`, destroy);
            return {destroy};
        });
        const devices = new Devices({sensor, removed} as any);
        const refreshed = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 21}});
        refreshed.makeCapabilityInstance = vi.fn(() => ({destroy: vi.fn()}));

        devices.registerDevices({sensor: refreshed} as any);

        expect(destroys.get('sensor:alarm_motion')).toHaveBeenCalledOnce();
        expect(destroys.get('removed:measure_temperature')).toHaveBeenCalledOnce();
        expect(devices.getDevice('removed')).toBeUndefined();
    });

    it('removes an unavailable device and recreates it when available again', () => {
        const destroy = vi.fn();
        const available = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 20}});
        available.makeCapabilityInstance = vi.fn(() => ({destroy}));
        const devices = new Devices({sensor: available} as any);
        const unavailable = {...available, available: false};

        devices.createOrUpdateDevice(unavailable);
        expect(devices.getDevice('sensor')).toBeUndefined();
        expect(destroy).toHaveBeenCalledOnce();

        const restored = makeApiDevice({id: 'sensor', capabilities: {measure_temperature: 21}});
        restored.makeCapabilityInstance = vi.fn(() => ({destroy: vi.fn()}));
        expect(devices.createOrUpdateDevice(restored)).toBeDefined();
        expect(devices.getDevice('sensor')?.getLocalCapabilityValue('measure_temperature').value).toBe(21);
    });

    it('creates, updates and deletes devices', () => {
        const calculator = {startCalculation: vi.fn()};
        const devices = new Devices();
        devices.setCalculator(calculator as any);
        const created = makeApiDevice({id: 'device', name: 'Old', zone: 'one'});
        expect(devices.createOrUpdateDevice(created)?.name).toBe('Old');
        expect(devices.createOrUpdateDevice({...created, name: 'New', zone: 'two'} as any)?.name).toBe('New');
        devices.deleteDevice(created);
        devices.deleteDevice(created);
        expect(devices.getDevice('device')).toBeUndefined();
        expect(calculator.startCalculation).toHaveBeenCalledTimes(3);
    });
});

describe('Devices updates to Homey', () => {
    it('updates local virtual devices, stores humidity and fires triggers', async () => {
        const addValue = vi.fn();
        const localDevice = {
            setCapabilityValue: vi.fn().mockResolvedValue(undefined),
            getValueStore: () => ({addValue}),
            getName: () => 'Humidity',
        };
        const trigger = vi.fn().mockResolvedValue(undefined);
        const homey = {
            app: {getDeviceByDataId: vi.fn().mockReturnValue(localDevice)},
            flow: {getDeviceTriggerCard: vi.fn().mockReturnValue({trigger})},
        };
        const devices = new Devices(undefined, homey);
        await devices.updateDevices(
            request({
                id: 'virtual',
                dataId: 'data-id',
                capabilityId: 'measure_humidity',
                value: 55,
                trigger: 'vh_onoff_true',
            }),
        );
        expect(localDevice.setCapabilityValue).toHaveBeenCalledWith('measure_humidity', 55);
        expect(addValue).toHaveBeenCalledWith(55);
        expect(trigger).toHaveBeenCalledWith(localDevice, {state: 1}, {});
    });

    it('awaits physical updates before applying a configured delay', async () => {
        const setCapabilityValue = vi.fn().mockResolvedValue(undefined);
        const delay = vi.fn().mockResolvedValue(undefined);
        const devices = new Devices(undefined, {app: {setCapabilityValue, delay}});
        await devices.updateDevices(request({id: 'heater', capabilityId: 'onoff', value: true, deviceDelay: 250}));
        expect(setCapabilityValue).toHaveBeenCalledWith('heater', 'onoff', true);
        expect(delay).toHaveBeenCalledWith(250);
        expect(setCapabilityValue.mock.invocationCallOrder[0]).toBeLessThan(delay.mock.invocationCallOrder[0]);
    });

    it('converts canonical Celsius when writing a Fahrenheit physical thermostat target', async () => {
        const thermostat = makeApiDevice({
            id: 'thermostat',
            deviceClass: DeviceClass.thermostat,
            capabilities: {target_temperature: 68},
        });
        thermostat.capabilitiesObj.target_temperature.units = '°F';
        const setCapabilityValue = vi.fn().mockResolvedValue(undefined);
        const devices = new Devices({thermostat} as any, {app: {setCapabilityValue}});

        await devices.updateDevices(request({id: 'thermostat', capabilityId: 'target_temperature', value: 21}));

        expect(setCapabilityValue).toHaveBeenCalledOnce();
        expect(setCapabilityValue.mock.calls[0]).toEqual(['thermostat', 'target_temperature', 69.8]);
        expect(devices.getDevice('thermostat')?.getLocalCapabilityValue('target_temperature').value).toBe(20);
    });

    it('does not resolve until an undelayed physical update completes', async () => {
        let finishWrite!: () => void;
        const write = new Promise<void>(resolve => {
            finishWrite = resolve;
        });
        const devices = new Devices(undefined, {
            app: {setCapabilityValue: vi.fn().mockReturnValue(write)},
        });
        let completed = false;
        const operation = devices
            .updateDevices(request({id: 'heater', capabilityId: 'onoff', value: true}))
            .then(() => {
                completed = true;
            });
        await Promise.resolve();
        const completedBeforeWrite = completed;
        finishWrite();
        await operation;
        expect(completedBeforeWrite).toBe(false);
    });

    it('clears a rejected physical update so the next calculation can try again', async () => {
        const heater = makeApiDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: true}});
        const startCalculation = vi.fn();
        const devices = new Devices({heater} as any, {
            app: {setCapabilityValue: vi.fn().mockRejectedValue(new Error('offline'))},
        });
        devices.setCalculator({startCalculation} as any);
        const calculator = new DeviceCalculator(new Zones(), devices);
        const physical = devices.getDevice('heater')!;

        const first = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', false);
        await devices.updateDevices(request(first!));
        const retry = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', false);

        expect(physical.getLocalCapabilityValue('onoff').value).toBe(true);
        expect(retry).toMatchObject({id: 'heater', capabilityId: 'onoff', value: false});
        expect(startCalculation).not.toHaveBeenCalled();
    });

    it('sends a reversal that supersedes an opposite unconfirmed physical update', async () => {
        const heater = makeApiDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: false}});
        const setCapabilityValue = vi.fn().mockResolvedValue(undefined);
        const devices = new Devices({heater} as any, {app: {setCapabilityValue}});
        const calculator = new DeviceCalculator(new Zones(), devices);
        const physical = devices.getDevice('heater')!;

        const turnOn = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', true);
        await devices.updateDevices(request(turnOn!));
        const turnOff = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', false);
        await devices.updateDevices(request(turnOff!));

        expect(setCapabilityValue.mock.calls).toEqual([
            ['heater', 'onoff', true],
            ['heater', 'onoff', false],
        ]);
    });

    it('does not resend an identical physical update while it remains unconfirmed', async () => {
        const heater = makeApiDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: true}});
        const setCapabilityValue = vi.fn().mockResolvedValue(undefined);
        const devices = new Devices({heater} as any, {app: {setCapabilityValue}});
        const calculator = new DeviceCalculator(new Zones(), devices);
        const physical = devices.getDevice('heater')!;

        const turnOff = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', false);
        await devices.updateDevices(request(turnOff!));
        const duplicate = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', false);

        expect(setCapabilityValue).toHaveBeenCalledOnce();
        expect(devices.getDevice('heater')?.getLocalCapabilityValue('onoff').value).toBe(true);
        expect(duplicate).toBeUndefined();
    });

    it('keeps the latest desired value pending when an obsolete confirmation arrives', async () => {
        let capabilityListener!: (value: unknown) => void;
        const heater = makeApiDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: false}});
        heater.makeCapabilityInstance = vi.fn((_id: string, listener: (value: unknown) => void) => {
            capabilityListener = listener;
            return {destroy: vi.fn()};
        });
        const devices = new Devices({heater} as any, {
            app: {setCapabilityValue: vi.fn().mockResolvedValue(undefined)},
        });
        const calculator = new DeviceCalculator(new Zones(), devices);
        const physical = devices.getDevice('heater')!;

        const turnOn = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', true);
        await devices.updateDevices(request(turnOn!));
        const turnOff = calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', false);
        await devices.updateDevices(request(turnOff!));

        capabilityListener(true);
        expect(calculator.updateAndCreateDeviceRequestIfChanged(physical, 'onoff', false)).toBeUndefined();
        capabilityListener(false);
        expect(physical.getLocalCapabilityValue('onoff').value).toBe(false);
    });

    it('clears a pending physical update when a capability event confirms it', async () => {
        let capabilityListener!: (value: unknown) => void;
        const heater = makeApiDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: true}});
        heater.makeCapabilityInstance = vi.fn((_id: string, listener: (value: unknown) => void) => {
            capabilityListener = listener;
            return {destroy: vi.fn()};
        });
        const setCapabilityValue = vi.fn().mockImplementation(async () => capabilityListener(false));
        const startCalculation = vi.fn();
        const devices = new Devices({heater} as any, {app: {setCapabilityValue}});
        devices.setCalculator({startCalculation} as any);

        await devices.updateDevices(request({id: 'heater', capabilityId: 'onoff', value: false}));

        expect(devices.getDevice('heater')?.getLocalCapabilityValue('onoff').value).toBe(false);
        expect(startCalculation).toHaveBeenCalledTimes(1);
        expect(startCalculation).toHaveBeenCalledWith();
    });

    it('confirms a canonical target write from its Fahrenheit capability event', async () => {
        let capabilityListener!: (value: unknown) => void;
        const thermostat = makeApiDevice({
            id: 'thermostat',
            deviceClass: DeviceClass.thermostat,
            capabilities: {target_temperature: 68},
        });
        thermostat.capabilitiesObj.target_temperature.units = '°F';
        thermostat.makeCapabilityInstance = vi.fn((_id: string, listener: (value: unknown) => void) => {
            capabilityListener = listener;
            return {destroy: vi.fn()};
        });
        const setCapabilityValue = vi.fn().mockImplementation(async (_id, _capabilityId, value) => {
            capabilityListener(value);
        });
        const startCalculation = vi.fn();
        const devices = new Devices({thermostat} as any, {app: {setCapabilityValue}});
        devices.setCalculator({startCalculation} as any);

        await devices.updateDevices(request({id: 'thermostat', capabilityId: 'target_temperature', value: 21}));

        expect(setCapabilityValue).toHaveBeenCalledWith('thermostat', 'target_temperature', 69.8);
        expect(devices.getDevice('thermostat')?.getLocalCapabilityValue('target_temperature').value).toBeCloseTo(21);
        expect(startCalculation).toHaveBeenCalledOnce();
    });

    it('logs and continues when a local device or physical write is unavailable', async () => {
        const logger = {warn: vi.fn(), error: vi.fn()};
        const homey = {
            app: {
                getDeviceByDataId: vi.fn().mockReturnValue(undefined),
                setCapabilityValue: vi
                    .fn()
                    .mockRejectedValueOnce(new Error('offline'))
                    .mockResolvedValueOnce(undefined),
            },
        };
        const devices = new Devices(undefined, homey, logger);
        const requests = new DeviceRequests();
        requests.addRequest(
            Object.assign(new DeviceRequest(), {
                id: 'local',
                dataId: 'missing',
                capabilityId: 'onoff',
                value: true,
            }),
        );
        requests.addRequest(
            Object.assign(new DeviceRequest(), {id: 'physical', capabilityId: 'onoff', value: true, deviceDelay: 1}),
        );
        requests.addRequest(
            Object.assign(new DeviceRequest(), {id: 'next', capabilityId: 'onoff', value: false, deviceDelay: 1}),
        );
        await devices.updateDevices(requests);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
        expect(homey.app.setCapabilityValue).toHaveBeenCalledTimes(2);
    });

    it('fires trigger-only requests with empty tokens without calling setCapabilityValue(undefined, ...)', async () => {
        const setCapabilityValue = vi.fn().mockResolvedValue(undefined);
        const trigger = vi.fn().mockResolvedValue(undefined);
        const localDevice = {setCapabilityValue};
        const homey = {
            app: {
                getDeviceByDataId: vi.fn().mockReturnValue(localDevice),
                setCapabilityValue: vi.fn(),
            },
            flow: {
                getDeviceTriggerCard: vi.fn().mockReturnValue({trigger}),
            },
        };
        const devices = new Devices(undefined, homey);
        const requests = new DeviceRequests();
        requests.addRequest(
            Object.assign(new DeviceRequest(), {
                id: 'vthermo-1',
                dataId: 'data-1',
                capabilityId: undefined,
                value: true,
                trigger: 'vt_frost_alarm_true',
            }),
        );

        await devices.updateDevices(requests);

        expect(setCapabilityValue).not.toHaveBeenCalled();
        expect(homey.flow.getDeviceTriggerCard).toHaveBeenCalledWith('vt_frost_alarm_true');
        expect(trigger).toHaveBeenCalledWith(localDevice, {}, {});
    });

    it('skips capability subscriptions for output-only virtual capabilities and preserves alarm state on re-register', () => {
        const makeCapabilityInstance = vi.fn().mockReturnValue({destroy: vi.fn()});
        const rawVThermo: any = {
            id: 'vt-1',
            name: 'VThermo',
            driverId: 'homey:app:no.almli.thermostat:VThermo',
            class: 'thermostat',
            zone: 'zone-1',
            available: true,
            ready: true,
            data: {id: 'data-1'},
            settings: {},
            capabilities: [
                'onoff',
                'target_temperature',
                'measure_temperature',
                'vt_onoff',
                'vt_cooling',
                'vt_dew_point',
                'vt_condensation_alarm',
            ],
            capabilitiesObj: {
                onoff: {value: true},
                target_temperature: {value: 20},
                measure_temperature: {value: 20},
                vt_onoff: {value: false},
                vt_cooling: {value: false},
                vt_dew_point: {value: 10},
                vt_condensation_alarm: {value: false},
            },
            makeCapabilityInstance,
        };

        const devices = new Devices({[rawVThermo.id]: rawVThermo});
        const subscribedCaps = makeCapabilityInstance.mock.calls.map(c => c[0]);
        expect(subscribedCaps).toEqual(['onoff', 'target_temperature', 'measure_temperature']);
        expect(subscribedCaps).not.toContain('vt_onoff');
        expect(subscribedCaps).not.toContain('vt_cooling');
        expect(subscribedCaps).not.toContain('vt_dew_point');
        expect(subscribedCaps).not.toContain('vt_condensation_alarm');

        const mapped = devices.getDevice('vt-1')!;
        mapped.frostAlarmActive = true;
        mapped.overheatAlarmActive = true;

        devices.createOrUpdateDevice(rawVThermo);
        expect(devices.getDevice('vt-1')?.frostAlarmActive).toBe(true);
        expect(devices.getDevice('vt-1')?.overheatAlarmActive).toBe(true);
    });

    it('averages multiple humidity sensors in getHumidityInZone', () => {
        const devices = new Devices({
            s1: {
                id: 's1',
                name: 'Sensor 1',
                driverId: 'sensor',
                class: 'sensor',
                zone: 'z1',
                available: true,
                ready: true,
                capabilities: ['measure_humidity'],
                capabilitiesObj: {measure_humidity: {value: 40}},
                makeCapabilityInstance: vi.fn(),
            },
            s2: {
                id: 's2',
                name: 'Sensor 2',
                driverId: 'sensor',
                class: 'sensor',
                zone: 'z1',
                available: true,
                ready: true,
                capabilities: ['measure_humidity'],
                capabilitiesObj: {measure_humidity: {value: 60}},
                makeCapabilityInstance: vi.fn(),
            },
        } as any);

        expect(devices.getHumidityInZone(makeZone('z1'))).toBe(50);
        expect(devices.getHumidityInZone(makeZone('empty-zone'))).toBeUndefined();
    });
});
