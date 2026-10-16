import {describe, expect, it, vi} from 'vitest';
import {capabilityIdFormat, DeviceRequest, DeviceRequests, DRIVER_VHUMIDITY, DRIVER_VTHERMO} from '../lib/types';
import {makeDevice} from './helpers';

describe('domain types', () => {
    it('identifies virtual thermostat driver types', () => {
        expect(makeDevice({driverId: DRIVER_VTHERMO}).isVThermo()).toBe(true);
        expect(makeDevice({driverId: DRIVER_VHUMIDITY}).isVHumidity()).toBe(true);
        expect(makeDevice().isVThermo()).toBe(false);
    });

    it('reads and detects local capability changes', () => {
        const device = makeDevice({capabilities: {onoff: false}});
        expect(device.hasCapability('onoff')).toBe(true);
        expect(device.getLocalCapabilityValue('missing')).toBeNull();
        expect(device.hasChangedValue('onoff', true)).toBe(true);
        expect(device.hasChangedValue('onoff', false)).toBe(false);
        expect(device.hasChangedValue('onoff', undefined)).toBe(false);
    });

    it('updates a known local capability and timestamp only', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1234);
        const device = makeDevice({capabilities: {onoff: false}});
        device.setLocalCapabilityValue('onoff', true);
        device.setLocalCapabilityValue('missing', true);
        expect(device.getLocalCapabilityValue('onoff')).toMatchObject({value: true, lastUpdated: 1234});
        expect(device.hasCapability('missing')).toBe(false);
    });

    it('formats capability instance keys', () => {
        expect(capabilityIdFormat('abc', 'measure_temperature')).toBe('abc_measure_temperature');
    });

    it('ignores absent requests and appends request groups', () => {
        const first = Object.assign(new DeviceRequest(), {id: 'a', capabilityId: 'onoff', value: true});
        const second = Object.assign(new DeviceRequest(), {id: 'b', capabilityId: 'onoff', value: false});
        const left = new DeviceRequests();
        const right = new DeviceRequests();
        left.addRequest(undefined);
        left.addRequest(first);
        right.addRequest(second);
        left.addRequests(right);
        expect(left.getRequests()).toEqual([first, second]);
    });

    it('deduplicates by device and capability with the last request winning', () => {
        const requests = new DeviceRequests();
        requests.addRequest(Object.assign(new DeviceRequest(), {id: 'a', capabilityId: 'onoff', value: false}));
        requests.addRequest(
            Object.assign(new DeviceRequest(), {id: 'a', capabilityId: 'target_temperature', value: 20}),
        );
        requests.addRequest(Object.assign(new DeviceRequest(), {id: 'a', capabilityId: 'onoff', value: true}));
        expect(DeviceRequests.unique(requests).getRequests()).toEqual([
            expect.objectContaining({capabilityId: 'onoff', value: true}),
            expect.objectContaining({capabilityId: 'target_temperature', value: 20}),
        ]);
    });

    it('deduplicates trigger-only requests by trigger name and tracks shortest pending calculation delay', () => {
        const left = new DeviceRequests();
        left.addRequest(Object.assign(new DeviceRequest(), {id: 'a', trigger: 'vt_frost_alarm_true', value: true}));
        left.addRequest(
            Object.assign(new DeviceRequest(), {id: 'a', trigger: 'vt_overheat_alarm_false', value: false}),
        );
        left.addRequest(Object.assign(new DeviceRequest(), {id: 'a', trigger: 'vt_frost_alarm_true', value: true}));
        left.addPendingDelay(5000);

        const right = new DeviceRequests();
        right.addPendingDelay(2000);
        right.addPendingDelay(0);
        left.addRequests(right);

        const unique = DeviceRequests.unique(left);
        expect(unique.getRequests()).toEqual([
            expect.objectContaining({id: 'a', trigger: 'vt_frost_alarm_true', value: true}),
            expect.objectContaining({id: 'a', trigger: 'vt_overheat_alarm_false', value: false}),
        ]);
        expect(unique.getNextCalculationDelay()).toBe(2000);
    });
});
