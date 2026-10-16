import {describe, expect, it, vi} from 'vitest';
import * as VHumidityDeviceModule from '../drivers/VHumidity/device';

const VHumidityDevice = (VHumidityDeviceModule as any).default ?? VHumidityDeviceModule;

function makeDevice({onoffEnabled = true, onoff = true}: {onoffEnabled?: boolean; onoff?: boolean} = {}) {
    const updateSettingsByDataId = vi.fn();
    const setCapabilityValue = vi.fn().mockResolvedValue(undefined);
    const device = Object.assign(Object.create(VHumidityDevice.prototype), {
        homey: {
            app: {updateSettingsByDataId},
            setTimeout: vi.fn(),
        },
        logger: {error: vi.fn(), info: vi.fn()},
        log: vi.fn(),
        getData: vi.fn().mockReturnValue({id: 'humidity-data-id'}),
        getSetting: vi.fn().mockReturnValue(onoffEnabled),
        getCapabilityValue: vi.fn().mockReturnValue(onoff),
        setCapabilityValue,
    });
    return {device, setCapabilityValue, updateSettingsByDataId};
}

describe('VHumidity Homey device', () => {
    it('refreshes mapped settings via updateSettingsByDataId without unmanaged setTimeout', async () => {
        const {device, updateSettingsByDataId} = makeDevice({onoffEnabled: true, onoff: true});
        const newSettings = {calc_method_humidity: 'AVERAGE', onoff_enabled: true};

        await device.onSettings({
            oldSettings: {calc_method_humidity: 'MIN', onoff_enabled: true},
            newSettings,
            changedKeys: ['calc_method_humidity'],
        });

        expect(updateSettingsByDataId).toHaveBeenCalledWith('humidity-data-id', newSettings);
        expect(device.homey.setTimeout).not.toHaveBeenCalled();
    });

    it('clears the value store on uninit', async () => {
        const {device} = makeDevice();
        const clear = vi.fn();
        device._humidityStore = {clear};

        await device.onUninit();

        expect(clear).toHaveBeenCalledOnce();
    });

    it('synchronizes onoff capability listener and updateTargetHumidity with the local app model', async () => {
        const listeners = new Map<string, (value: unknown, opts: unknown) => Promise<void>>();
        const updateByDataId = vi.fn();
        const setCapabilityValue = vi.fn().mockResolvedValue(undefined);
        const trigger = vi.fn().mockResolvedValue(undefined);
        const device = Object.assign(Object.create(VHumidityDevice.prototype), {
            homey: {
                __: vi.fn().mockReturnValue('Switching disabled'),
                app: {updateByDataId},
                flow: {getDeviceTriggerCard: vi.fn().mockReturnValue({trigger})},
            },
            logger: {error: vi.fn(), info: vi.fn()},
            getData: vi.fn().mockReturnValue({id: 'humidity-data-id'}),
            getSetting: vi.fn().mockReturnValue(true),
            setCapabilityValue,
            registerCapabilityListener: vi.fn((capId, listener) => listeners.set(capId, listener)),
        });

        await device.initialize();
        await listeners.get('onoff')!(false, {});
        expect(updateByDataId).toHaveBeenCalledWith('humidity-data-id', 'onoff', false);

        await device.updateTargetHumidity(55);
        expect(setCapabilityValue).toHaveBeenCalledWith('vh_target_humidity', 55);
        expect(setCapabilityValue).toHaveBeenCalledWith('vh_target_humidity_view', 55);
        expect(updateByDataId).toHaveBeenCalledWith('humidity-data-id', 'vh_target_humidity', 55);
        expect(trigger).toHaveBeenCalledWith(device, {humidity: 55});
    });
});
