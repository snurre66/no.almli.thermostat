import {describe, expect, it, vi} from 'vitest';
import {VThermoDeviceCalculator} from '../lib/VThermoDeviceCalculator';
import {DeviceMapper} from '../lib/DeviceMapper';
import {Zones} from '../lib/Zones';
import {CalcMethod, CAPABILITY_ACTIVE, DeviceCapability, DeviceClass, TemperatureSettingsZone} from '../lib/types';
import {makeApiDevice, makeDevice, makeDevicesStub, makeVThermo, makeZone, NOW} from './helpers';

describe('VThermoDeviceCalculator temperature inputs', () => {
    it('selects enabled sensor categories and excludes the controlling virtual thermostat', () => {
        const root = makeZone('root');
        const sensor = makeDevice({id: 'sensor', capabilities: {measure_temperature: 10}});
        const thermostat = makeDevice({
            id: 'thermostat',
            deviceClass: DeviceClass.thermostat,
            capabilities: {measure_temperature: 20},
        });
        const virtual = makeVThermo({capabilities: {measure_temperature: 30}});
        const other = makeDevice({id: 'other', deviceClass: 'speaker', capabilities: {measure_temperature: 40}});
        const calculator = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([sensor, thermostat, virtual, other]),
        );
        const settings = Object.assign(new TemperatureSettingsZone(), {
            sensor: true,
            thermostat: true,
            vthermo: false,
            other: true,
        });
        expect(calculator.getTemperaturesInZone(root, settings).map(value => value.value)).toEqual([10, 20, 40]);
    });

    it('does not duplicate readings when several zones are selected', () => {
        const zones = [makeZone('one'), makeZone('two')];
        const calculator = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([
                makeDevice({id: 'one', zone: 'one', capabilities: {measure_temperature: 10}}),
                makeDevice({id: 'two', zone: 'two', capabilities: {measure_temperature: 20}}),
            ]),
        );
        expect(calculator.getTemperaturesInZone(zones, {sensor: true}).map(value => value.value)).toEqual([10, 20]);
        expect(calculator.getTemperaturesInZone([], {sensor: true})).toEqual([]);
        expect(calculator.getTemperaturesInZone(undefined, {sensor: true})).toEqual([]);
    });

    it('combines current, parent and direct-child sensor scopes', () => {
        const child = makeZone('child', 'root');
        const root = makeZone('root', 'parent', [child]);
        const parent = makeZone('parent', undefined, [root]);
        const zones = new Zones({
            parent: {id: 'parent', name: 'Parent', parent: null},
            root: {id: 'root', name: 'Root', parent: 'parent'},
            child: {id: 'child', name: 'Child', parent: 'root'},
        } as any);
        const calculator = new VThermoDeviceCalculator(
            zones,
            makeDevicesStub([
                makeDevice({id: 'parent-sensor', zone: parent.id, capabilities: {measure_temperature: 10}}),
                makeDevice({id: 'root-sensor', zone: root.id, capabilities: {measure_temperature: 20}}),
                makeDevice({id: 'child-sensor', zone: child.id, capabilities: {measure_temperature: 30}}),
            ]),
        );
        expect(
            calculator
                .getTemperatures(root, zones, {
                    calcMethod: CalcMethod.AVERAGE,
                    zone: {sensor: true},
                    parent: {sensor: true},
                    children: {sensor: true},
                })
                .map(value => value.value),
        ).toEqual([20, 10, 30]);
    });

    it('does not overwrite a manual temperature', () => {
        const device = makeVThermo({temperatureSettings: {calcMethod: CalcMethod.MANUAL}});
        const calculator = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([]));
        expect(calculator.calculateMeasureTemperature(device, makeZone('root'))).toBeUndefined();
    });

    it('averages valid readings and includes validation boundaries', () => {
        const device = makeVThermo({
            capabilities: {measure_temperature: 0},
            temperatureSettings: {
                calcMethod: CalcMethod.AVERAGE,
                validate: true,
                validate_min: 10,
                validate_max: 30,
                zone: {sensor: true},
            },
        });
        const calculator = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([
                makeDevice({id: 'low', capabilities: {measure_temperature: 9}}),
                makeDevice({id: 'min', capabilities: {measure_temperature: 10}}),
                makeDevice({id: 'max', capabilities: {measure_temperature: 30}}),
                makeDevice({id: 'high', capabilities: {measure_temperature: 31}}),
            ]),
        );
        expect(calculator.calculateMeasureTemperature(device, makeZone('root'))).toMatchObject({
            capabilityId: 'measure_temperature',
            value: 20,
        });
    });

    it('averages equivalent Celsius and Fahrenheit API readings in Celsius', () => {
        const celsius = DeviceMapper.map(makeApiDevice({id: 'celsius', capabilities: {measure_temperature: 20}}));
        const fahrenheitApi = makeApiDevice({id: 'fahrenheit', capabilities: {measure_temperature: 77}});
        fahrenheitApi.capabilitiesObj.measure_temperature.units = '°F';
        const fahrenheit = DeviceMapper.map(fahrenheitApi);
        const device = makeVThermo({
            capabilities: {measure_temperature: 0},
            temperatureSettings: {calcMethod: CalcMethod.AVERAGE, zone: {sensor: true}},
        });

        expect(
            new VThermoDeviceCalculator(
                new Zones(),
                makeDevicesStub([celsius, fahrenheit]),
            ).calculateMeasureTemperature(device, makeZone('root')),
        ).toMatchObject({value: 22.5});
    });

    it('returns null when no automatic reading is available', () => {
        const device = makeVThermo({
            capabilities: {measure_temperature: 20},
            temperatureSettings: {calcMethod: CalcMethod.AVERAGE, zone: {sensor: true}},
        });
        const request = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([])).calculateMeasureTemperature(
            device,
            makeZone('root'),
        );
        expect(request).toMatchObject({value: null});
    });

    it('applies maximum-age filtering to the MAX calculation method', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const calculator = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([]));
        const result = (calculator as any).calculateTemperature(
            [new DeviceCapability(99, NOW - 60_000), new DeviceCapability(20, NOW)],
            {calcMethod: CalcMethod.MAX, measurementMaxAge: 1000},
        );
        expect(result).toBe(20);
        vi.useRealTimers();
    });
});

describe('VThermoDeviceCalculator switching', () => {
    const calculator = () => new VThermoDeviceCalculator(new Zones(), makeDevicesStub([]));

    it('turns heating on below and off above the hysteresis band', () => {
        const device = makeVThermo();
        expect(calculator().resolveOnOff(device, 19.49, 20)).toBe(true);
        expect(calculator().resolveOnOff(device, 20.51, 20)).toBe(false);
    });

    it('does nothing at the hysteresis boundaries or within the band', () => {
        const device = makeVThermo();
        expect(calculator().resolveOnOff(device, 19.5, 20)).toBeUndefined();
        expect(calculator().resolveOnOff(device, 20, 20)).toBeUndefined();
        expect(calculator().resolveOnOff(device, 20.5, 20)).toBeUndefined();
    });

    it('supports zero hysteresis without changing state exactly at the target', () => {
        const device = makeVThermo({deviceSettings: {hysteresis: 0}});
        expect(calculator().resolveOnOff(device, 19.99, 20)).toBe(true);
        expect(calculator().resolveOnOff(device, 20, 20)).toBeUndefined();
        expect(calculator().resolveOnOff(device, 20.01, 20)).toBe(false);
    });

    it('uses the default hysteresis when the setting is undefined', () => {
        const device = makeVThermo({deviceSettings: {hysteresis: undefined}});
        expect(calculator().resolveOnOff(device, 19.75, 20)).toBeUndefined();
        expect(calculator().resolveOnOff(device, 19.49, 20)).toBe(true);
    });

    it('reverses threshold behavior when thermostat_mode is cool', () => {
        const device = makeVThermo({capabilities: {thermostat_mode: 'cool'}});
        expect(calculator().resolveOnOff(device, 19, 20)).toBe(false);
        expect(calculator().resolveOnOff(device, 21, 20)).toBe(true);
    });

    it('turns active heating off when the main switch is off', () => {
        const active = makeVThermo({capabilities: {onoff: false, [CAPABILITY_ACTIVE]: true}});
        const idle = makeVThermo({capabilities: {onoff: false, [CAPABILITY_ACTIVE]: false}});
        expect(calculator().resolveOnOff(active, 10, 20)).toBe(false);
        expect(calculator().resolveOnOff(idle, 10, 20)).toBeUndefined();
    });

    it('ignores the main switch when on/off control is disabled', () => {
        const device = makeVThermo({
            capabilities: {onoff: false},
            deviceSettings: {onoffEnabled: false},
        });
        expect(calculator().resolveOnOff(device, 10, 20)).toBe(true);
    });

    it('gives contact alarms priority over motion alarms', () => {
        const device = makeVThermo({capabilities: {[CAPABILITY_ACTIVE]: true}});
        expect(calculator().resolveOnOff(device, 10, 20, true, true)).toBe(false);
        expect(calculator().resolveOnOff(device, 20, 20, false, true)).toBe(true);
    });

    it('rejects non-VThermo devices and devices without settings', () => {
        expect(
            calculator().resolveOnOff(makeDevice({capabilities: {onoff: true, [CAPABILITY_ACTIVE]: false}}), 10, 20),
        ).toBeUndefined();
        const withoutSettings = makeVThermo();
        withoutSettings.deviceSettings = undefined;
        expect(calculator().resolveOnOff(withoutSettings, 10, 20)).toBeUndefined();
    });

    it('creates virtual, heater and physical thermostat requests with triggers and delay', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {measure_temperature: 18, target_temperature: 20, [CAPABILITY_ACTIVE]: false},
            deviceSettings: {
                zone: {clazz: true, thermostats: true},
                sub_zones: {clazz: false, thermostats: false},
                deviceDelay: 250,
            },
        });
        const heater = makeDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: false}});
        const thermostat = makeDevice({
            id: 'physical',
            deviceClass: DeviceClass.thermostat,
            capabilities: {target_temperature: 18, measure_temperature: 20},
        });
        const requests = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, heater, thermostat]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();
        expect(requests).toEqual([
            expect.objectContaining({
                dataId: 'vthermo-data',
                capabilityId: CAPABILITY_ACTIVE,
                value: true,
                trigger: 'vt_onoff_true',
            }),
            expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: true, deviceDelay: 250}),
            expect.objectContaining({id: 'physical', capabilityId: 'target_temperature', value: 22, deviceDelay: 250}),
        ]);
    });

    it('preserves the current output without target or measured temperature', () => {
        const root = makeZone('root');
        const noTarget = makeVThermo({capabilities: {target_temperature: null}});
        const noMeasurement = makeVThermo({capabilities: {measure_temperature: null, [CAPABILITY_ACTIVE]: true}});
        expect(calculator().calculateHeaterSwitching(noTarget, root).getRequests()).toEqual([]);
        expect(calculator().calculateHeaterSwitching(noMeasurement, root).getRequests()).toEqual([]);
    });

    it('turns controlled heaters off when VThermo is switched off without a usable temperature', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                onoff: false,
                [CAPABILITY_ACTIVE]: false,
                target_temperature: null,
                measure_temperature: null,
            },
        });
        const heater = makeDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: true}});
        const requests = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, heater]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        expect(requests).toEqual([expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: false})]);
    });

    it('selects heaters and thermostats from independently enabled zone scopes', () => {
        const child = makeZone('child', 'root');
        const root = makeZone('root', undefined, [child]);
        const rootHeater = makeDevice({id: 'root-heater', deviceClass: DeviceClass.heater, zone: 'root'});
        const childHeater = makeDevice({id: 'child-heater', deviceClass: DeviceClass.heater, zone: 'child'});
        const rootThermostat = makeDevice({id: 'root-thermostat', deviceClass: DeviceClass.thermostat, zone: 'root'});
        const childThermostat = makeDevice({
            id: 'child-thermostat',
            deviceClass: DeviceClass.thermostat,
            zone: 'child',
        });
        const calc = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([rootHeater, childHeater, rootThermostat, childThermostat]),
        );
        const settings = {zone: {clazz: true, thermostats: false}, sub_zones: {clazz: false, thermostats: true}};
        expect(calc.getHeaters(root, new Zones(), settings).map(device => device.id)).toEqual(['root-heater']);
        expect(calc.getThermostats(root, new Zones(), settings).map(device => device.id)).toEqual(['child-thermostat']);
    });

    it('selects coolers (air conditioners, fans, refrigerators) and sockets from enabled zone scopes', () => {
        const child = makeZone('child', 'root');
        const root = makeZone('root', undefined, [child]);
        const ac = makeDevice({id: 'ac', deviceClass: DeviceClass.airconditioner, zone: 'root'});
        const fan = makeDevice({id: 'fan', deviceClass: DeviceClass.fan, zone: 'root'});
        const fridge = makeDevice({id: 'fridge', deviceClass: DeviceClass.refrigerator, zone: 'root'});
        const socketHeater = makeDevice({id: 'socket-heater', deviceClass: DeviceClass.socket, zone: 'root'});
        const socketCooler = makeDevice({id: 'socket-cooler', deviceClass: DeviceClass.socket, zone: 'child'});
        const childAc = makeDevice({id: 'child-ac', deviceClass: DeviceClass.airconditioner, zone: 'child'});

        const calc = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([ac, fan, fridge, socketHeater, socketCooler, childAc]),
        );

        const settings = {
            zone: {clazz: false, coolers: true, sockets_heaters: true, sockets_coolers: false, thermostats: false},
            sub_zones: {clazz: false, coolers: true, sockets_heaters: false, sockets_coolers: true, thermostats: false},
        };

        expect(calc.getHeaters(root, new Zones(), settings).map(d => d.id)).toEqual(['socket-heater']);
        expect(calc.getCoolers(root, new Zones(), settings).map(d => d.id)).toEqual([
            'ac',
            'fan',
            'fridge',
            'socket-cooler',
            'child-ac',
        ]);
    });

    it('handles cooling mode and generates vt_cooling requests', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                measure_temperature: 24,
                target_temperature: 22,
                thermostat_mode: 'cool',
                vt_cooling: false,
                [CAPABILITY_ACTIVE]: false,
            },
            deviceSettings: {
                zone: {clazz: true, coolers: true, thermostats: false},
                sub_zones: {clazz: false, coolers: false, thermostats: false},
            },
        });
        const ac = makeDevice({id: 'ac', deviceClass: DeviceClass.airconditioner, capabilities: {onoff: false}});
        const heater = makeDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: true}});

        const requests = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, ac, heater]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        expect(requests).toContainEqual(
            expect.objectContaining({capabilityId: 'vt_cooling', value: true, trigger: 'vt_cooling_true'}),
        );
        expect(requests).toContainEqual(expect.objectContaining({id: 'ac', capabilityId: 'onoff', value: true}));
    });

    it('handles auto climate mode by activating heat below setpoint and cool above setpoint', () => {
        const root = makeZone('root');
        const calc = (temp: number, initialActive = false, initialCooling = false) => {
            const vthermo = makeVThermo({
                capabilities: {
                    measure_temperature: temp,
                    target_temperature: 20,
                    thermostat_mode: 'auto',
                    vt_cooling: initialCooling,
                    [CAPABILITY_ACTIVE]: initialActive,
                },
                deviceSettings: {
                    hysteresis: 1.0,
                    zone: {clazz: true, coolers: true, thermostats: false},
                    sub_zones: {clazz: false, coolers: false, thermostats: false},
                },
            });
            const ac = makeDevice({
                id: 'ac',
                deviceClass: DeviceClass.airconditioner,
                capabilities: {onoff: initialCooling},
            });
            const heater = makeDevice({
                id: 'heater',
                deviceClass: DeviceClass.heater,
                capabilities: {onoff: initialActive},
            });
            return new VThermoDeviceCalculator(
                new Zones(),
                makeDevicesStub([vthermo, ac, heater]),
            ).calculateHeaterSwitching(vthermo, root);
        };

        // Below 19 (target 20 - hyst 1.0) transitioning from cooling: heat ON, cool OFF
        const heatReqs = calc(18.5, false, true).getRequests();
        expect(heatReqs).toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: true}));
        expect(heatReqs).toContainEqual(expect.objectContaining({capabilityId: 'vt_cooling', value: false}));
        expect(heatReqs).toContainEqual(expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: true}));
        expect(heatReqs).toContainEqual(expect.objectContaining({id: 'ac', capabilityId: 'onoff', value: false}));

        // Above 21 (target 20 + hyst 1.0) transitioning from heating: heat OFF, cool ON
        const coolReqs = calc(21.5, true, false).getRequests();
        expect(coolReqs).toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: false}));
        expect(coolReqs).toContainEqual(expect.objectContaining({capabilityId: 'vt_cooling', value: true}));
        expect(coolReqs).toContainEqual(expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: false}));
        expect(coolReqs).toContainEqual(expect.objectContaining({id: 'ac', capabilityId: 'onoff', value: true}));

        // Inside deadband (20.0) with both previously active: both turn OFF
        const deadbandReqs = calc(20.0, true, true).getRequests();
        expect(deadbandReqs).toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: false}));
        expect(deadbandReqs).toContainEqual(expect.objectContaining({capabilityId: 'vt_cooling', value: false}));
    });

    it('shuts down heating and cooling in off mode', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                measure_temperature: 15,
                target_temperature: 20,
                thermostat_mode: 'off',
                vt_cooling: true,
                [CAPABILITY_ACTIVE]: true,
            },
            deviceSettings: {
                zone: {clazz: true, coolers: true, thermostats: false},
            },
        });
        const requests = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        expect(requests).toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: false}));
        expect(requests).toContainEqual(expect.objectContaining({capabilityId: 'vt_cooling', value: false}));
    });

    it('prevents rapid short-cycling with min_off_duration and min_on_duration', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {measure_temperature: 18, target_temperature: 20, [CAPABILITY_ACTIVE]: false},
            deviceSettings: {
                minOffDuration: 180_000,
                minOnDuration: 60_000,
                zone: {clazz: true, coolers: false, thermostats: false},
            },
        });
        // Heater was switched OFF 30 seconds ago (within 180s min_off_duration)
        const recentHeater = makeDevice({
            id: 'recent-heater',
            deviceClass: DeviceClass.heater,
            capabilities: {onoff: false},
        });
        recentHeater.capabilitiesObj!.get('onoff')!.lastUpdated = Date.now() - 30_000;

        const oldHeater = makeDevice({
            id: 'old-heater',
            deviceClass: DeviceClass.heater,
            capabilities: {onoff: false},
        });
        oldHeater.capabilitiesObj!.get('onoff')!.lastUpdated = Date.now() - 200_000;

        const requests = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, recentHeater, oldHeater]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        // oldHeater should turn ON, recentHeater should be suppressed due to anti-short-cycling
        expect(requests).toContainEqual(
            expect.objectContaining({id: 'old-heater', capabilityId: 'onoff', value: true}),
        );
        expect(requests).not.toContainEqual(expect.objectContaining({id: 'recent-heater'}));
    });

    it('honors contact_alarm_delay before turning off heating', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {measure_temperature: 18, target_temperature: 20, [CAPABILITY_ACTIVE]: true},
            deviceSettings: {
                contactAlarm: true,
                contactAlarmDelay: 30_000,
                zone: {clazz: true, coolers: false, thermostats: false},
            },
        });
        const heater = makeDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: true}});

        // Contact sensor opened 10 seconds ago (< 30s delay)
        const contactSensorRecent = makeDevice({
            id: 'sensor',
            deviceClass: DeviceClass.sensor,
            capabilities: {alarm_contact: true},
        });
        contactSensorRecent.capabilitiesObj!.get('alarm_contact')!.lastUpdated = Date.now() - 10_000;

        const reqsRecent = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([vthermo, heater, contactSensorRecent]),
        )
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        // Heating should remain ON because delay has not elapsed
        expect(reqsRecent).not.toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: false}));

        // Contact sensor opened 40 seconds ago (>= 30s delay)
        const contactSensorOld = makeDevice({
            id: 'sensor-old',
            deviceClass: DeviceClass.sensor,
            capabilities: {alarm_contact: true},
        });
        contactSensorOld.capabilitiesObj!.get('alarm_contact')!.lastUpdated = Date.now() - 40_000;

        const reqsOld = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, heater, contactSensorOld]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        // Heating turns OFF after delay elapsed
        expect(reqsOld).toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: false}));
    });

    it('applies thermostat_preset offsets and away temperature correctly', () => {
        const root = makeZone('root');
        const makePresetCalc = (preset: string, temp: number) => {
            const vthermo = makeVThermo({
                capabilities: {
                    measure_temperature: temp,
                    target_temperature: 20,
                    vt_thermostat_preset: preset,
                    thermostat_mode: 'heat',
                    [CAPABILITY_ACTIVE]: false,
                },
                deviceSettings: {
                    presetEcoOffset: -2.0,
                    presetAwayTemp: 12.0,
                    presetBoostOffset: 2.0,
                    hysteresis: 0.5,
                    zone: {clazz: true, coolers: false, thermostats: false},
                },
            });
            const heater = makeDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: false}});
            return new VThermoDeviceCalculator(
                new Zones(),
                makeDevicesStub([vthermo, heater]),
            ).calculateHeaterSwitching(vthermo, root);
        };

        // Comfort (target 20): at 19.0 (below 19.5), heat turns ON
        expect(makePresetCalc('comfort', 19.0).getRequests()).toContainEqual(
            expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: true}),
        );

        // Eco (target 20 - 2 = 18): at 19.0 (above 17.5), heat stays OFF
        expect(makePresetCalc('eco', 19.0).getRequests()).not.toContainEqual(
            expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: true}),
        );

        // Away (target fixed 12.0): at 13.0, heat stays OFF; at 11.0 (below 11.5), heat turns ON
        expect(makePresetCalc('away', 13.0).getRequests()).not.toContainEqual(
            expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: true}),
        );
        expect(makePresetCalc('away', 11.0).getRequests()).toContainEqual(
            expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: true}),
        );
    });

    it('supports heating and cooling in auto mode with single setpoint and deadband', () => {
        const root = makeZone('root');
        const calcAuto = (temp: number) => {
            const vthermo = makeVThermo({
                capabilities: {
                    measure_temperature: temp,
                    target_temperature: 21.0,
                    thermostat_mode: 'auto',
                    vt_cooling: false,
                    [CAPABILITY_ACTIVE]: false,
                },
                deviceSettings: {
                    hysteresis: 0.5,
                    zone: {clazz: true, coolers: true, thermostats: false},
                },
            });
            const heater = makeDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: false}});
            const ac = makeDevice({id: 'ac', deviceClass: DeviceClass.airconditioner, capabilities: {onoff: false}});
            return new VThermoDeviceCalculator(
                new Zones(),
                makeDevicesStub([vthermo, heater, ac]),
            ).calculateHeaterSwitching(vthermo, root);
        };

        // At 20.0 (below target 21.0 - 0.5): heat ON, cool OFF
        const heatReqs = calcAuto(20.0).getRequests();
        expect(heatReqs).toContainEqual(expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: true}));
        expect(heatReqs).not.toContainEqual(expect.objectContaining({id: 'ac', capabilityId: 'onoff', value: true}));

        // At 21.0 (between 20.5 and 21.5): deadband, neither heat nor cool is ON
        const midReqs = calcAuto(21.0).getRequests();
        expect(midReqs).not.toContainEqual(expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: true}));
        expect(midReqs).not.toContainEqual(expect.objectContaining({id: 'ac', capabilityId: 'onoff', value: true}));

        // At 22.0 (above target 21.0 + 0.5): cool ON, heat OFF
        const coolReqs = calcAuto(22.0).getRequests();
        expect(coolReqs).toContainEqual(expect.objectContaining({id: 'ac', capabilityId: 'onoff', value: true}));
        expect(coolReqs).not.toContainEqual(
            expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: true}),
        );
    });

    it('shuts down heating and cooling safely when fail-safe is enabled and temperature is missing', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                measure_temperature: null as any,
                target_temperature: 20,
                [CAPABILITY_ACTIVE]: true,
                vt_cooling: true,
            },
            deviceSettings: {
                failsafeEnabled: true,
                zone: {clazz: true, coolers: true, thermostats: false},
            },
        });
        const requests = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        expect(requests).toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: false}));
        expect(requests).toContainEqual(expect.objectContaining({capabilityId: 'vt_cooling', value: false}));
    });

    it('triggers frost and overheat safety alarms and cuts off heating on overheat', () => {
        const root = makeZone('root');
        const calcSafety = (temp: number) => {
            const vthermo = makeVThermo({
                capabilities: {
                    measure_temperature: temp,
                    target_temperature: 20,
                    [CAPABILITY_ACTIVE]: true,
                },
                deviceSettings: {
                    frostAlarmTemp: 5.0,
                    overheatAlarmTemp: 40.0,
                    zone: {clazz: true, coolers: false, thermostats: false},
                },
            });
            const heater = makeDevice({id: 'heater', deviceClass: DeviceClass.heater, capabilities: {onoff: true}});
            return new VThermoDeviceCalculator(
                new Zones(),
                makeDevicesStub([vthermo, heater]),
            ).calculateHeaterSwitching(vthermo, root);
        };

        // Frost alarm at 4°C (< 5°C limit)
        const frostReqs = calcSafety(4.0).getRequests();
        expect(frostReqs).toContainEqual(expect.objectContaining({trigger: 'vt_frost_alarm_true'}));

        // Overheat alarm at 42°C (> 40°C limit): triggers overheat alarm and cuts off heating
        const overheatReqs = calcSafety(42.0).getRequests();
        expect(overheatReqs).toContainEqual(expect.objectContaining({trigger: 'vt_overheat_alarm_true'}));
        expect(overheatReqs).toContainEqual(expect.objectContaining({capabilityId: CAPABILITY_ACTIVE, value: false}));
    });

    it('suppresses cooling when condensation protection detects room temp near dew point', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                measure_temperature: 24.0,
                target_temperature: 20.0,
                thermostat_mode: 'cool',
                vt_cooling: true,
            },
            deviceSettings: {
                condensationProtection: true,
                zone: {clazz: false, coolers: true, thermostats: false},
            },
        });
        // Humidity is 95% at 24°C -> Dew point is ~23.1°C (within 1°C of 24°C)
        const humiditySensor = makeDevice({
            id: 'hum-sensor',
            deviceClass: DeviceClass.sensor,
            zone: 'root',
            capabilities: {measure_humidity: 95},
        });
        const ac = makeDevice({id: 'ac', deviceClass: DeviceClass.airconditioner, capabilities: {onoff: true}});

        const requests = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, humiditySensor, ac]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();

        // Cooling should be shut off to prevent condensation
        expect(requests).toContainEqual(expect.objectContaining({capabilityId: 'vt_cooling', value: false}));
        expect(requests).toContainEqual(
            expect.objectContaining({capabilityId: 'vt_dew_point', value: 23.15, trigger: 'vt_dew_point_changed'}),
        );
        expect(requests).toContainEqual(expect.objectContaining({capabilityId: 'vt_condensation_alarm', value: true}));

        // Inside 0.5°C clearing deadband (temp 24.3°C vs dew point ~23.44°C -> diff ~0.86°C or 1.2°C): alarm stays true
        vthermo.setLocalCapabilityValue('measure_temperature', 24.4);
        humiditySensor.setLocalCapabilityValue('measure_humidity', 94); // dp ~23.36 -> diff ~1.04°C (< 1.5°C)
        const deadbandReqs = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, humiditySensor, ac]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();
        expect(deadbandReqs).not.toContainEqual(
            expect.objectContaining({capabilityId: 'vt_condensation_alarm', value: false}),
        );

        // Once room temp is >= dp + 1.5°C (e.g. humidity drops to 60%), condensation alarm clears
        humiditySensor.setLocalCapabilityValue('measure_humidity', 60);
        const clearReqs = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, humiditySensor, ac]))
            .calculateHeaterSwitching(vthermo, root)
            .getRequests();
        expect(clearReqs).toContainEqual(
            expect.objectContaining({
                capabilityId: 'vt_condensation_alarm',
                value: false,
                trigger: 'vt_condensation_alarm_false',
            }),
        );
    });

    it('fires frost and overheat alarm triggers only on state transitions with 0.5°C clearing hysteresis', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                measure_temperature: 4.0,
                target_temperature: 20,
                [CAPABILITY_ACTIVE]: false,
            },
            deviceSettings: {
                frostAlarmTemp: 5.0,
                overheatAlarmTemp: 40.0,
                zone: {clazz: true, coolers: false, thermostats: false},
            },
        });
        const calc = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo]));

        // First run at 4.0°C (< 5.0°C): triggers vt_frost_alarm_true without a capabilityId
        const firstFrost = calc.calculateHeaterSwitching(vthermo, root).getRequests();
        const frostTriggerReq = firstFrost.find(r => r.trigger === 'vt_frost_alarm_true');
        expect(frostTriggerReq).toBeDefined();
        expect(frostTriggerReq?.capabilityId).toBeUndefined();

        // Second run at 5.2°C (within 0.5°C clearing deadband): no duplicate trigger and does not clear yet
        vthermo.setLocalCapabilityValue('measure_temperature', 5.2);
        const secondFrost = calc.calculateHeaterSwitching(vthermo, root).getRequests();
        expect(secondFrost.find(r => r.trigger?.startsWith('vt_frost_alarm'))).toBeUndefined();

        // Third run at 5.5°C (>= 5.0 + 0.5): clears frost alarm once
        vthermo.setLocalCapabilityValue('measure_temperature', 5.5);
        const clearFrost = calc.calculateHeaterSwitching(vthermo, root).getRequests();
        expect(clearFrost).toContainEqual(expect.objectContaining({trigger: 'vt_frost_alarm_false', value: false}));

        // Overheat transition: 41.0°C (> 40.0°C) triggers once, 39.7°C stays active, 39.5°C clears
        vthermo.setLocalCapabilityValue('measure_temperature', 41.0);
        expect(calc.calculateHeaterSwitching(vthermo, root).getRequests()).toContainEqual(
            expect.objectContaining({trigger: 'vt_overheat_alarm_true', value: true}),
        );
        vthermo.setLocalCapabilityValue('measure_temperature', 39.7);
        expect(
            calc
                .calculateHeaterSwitching(vthermo, root)
                .getRequests()
                .find(r => r.trigger?.startsWith('vt_overheat_alarm')),
        ).toBeUndefined();
        vthermo.setLocalCapabilityValue('measure_temperature', 39.5);
        expect(calc.calculateHeaterSwitching(vthermo, root).getRequests()).toContainEqual(
            expect.objectContaining({trigger: 'vt_overheat_alarm_false', value: false}),
        );
    });

    it('preserves heating and cooling hysteresis bands in auto mode', () => {
        const vthermo = makeVThermo({
            capabilities: {
                onoff: true,
                thermostat_mode: 'auto',
                [CAPABILITY_ACTIVE]: false,
                vt_cooling: false,
            },
            deviceSettings: {
                hysteresis: 0.5,
            },
        });
        const calc = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo]));

        // heatTarget = 20.0, coolTarget = 22.0, hysteresis = 0.5
        // Below 19.5 -> heating turns ON
        expect(calc.resolveClimateOnOff(vthermo, 19.4, 20.0, 22.0)).toEqual({heatOnoff: true, coolOnoff: false});

        // While heating is ON, at 19.8 (between 19.5 and 20.0) -> heating stays ON
        vthermo.setLocalCapabilityValue(CAPABILITY_ACTIVE, true);
        expect(calc.resolveClimateOnOff(vthermo, 19.8, 20.0, 22.0)).toEqual({heatOnoff: true, coolOnoff: false});

        // At 20.0 (heatTarget reached) -> heating turns OFF
        expect(calc.resolveClimateOnOff(vthermo, 20.0, 20.0, 22.0)).toEqual({heatOnoff: false, coolOnoff: false});

        // Above 22.5 -> cooling turns ON
        vthermo.setLocalCapabilityValue(CAPABILITY_ACTIVE, false);
        expect(calc.resolveClimateOnOff(vthermo, 22.6, 20.0, 22.0)).toEqual({heatOnoff: false, coolOnoff: true});

        // While cooling is ON, at 22.2 (between 22.0 and 22.5) -> cooling stays ON
        vthermo.setLocalCapabilityValue('vt_cooling', true);
        expect(calc.resolveClimateOnOff(vthermo, 22.2, 20.0, 22.0)).toEqual({heatOnoff: false, coolOnoff: true});

        // At 22.0 (coolTarget reached) -> cooling turns OFF
        expect(calc.resolveClimateOnOff(vthermo, 22.0, 20.0, 22.0)).toEqual({heatOnoff: false, coolOnoff: false});
    });

    it('reports pending delay for contact_alarm_delay and anti-short-cycling and catches up devices after expiry', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                measure_temperature: 22.0,
                target_temperature: 20.0,
                [CAPABILITY_ACTIVE]: true,
            },
            deviceSettings: {
                hysteresis: 0.5,
                contactAlarm: true,
                contactAlarmDelay: 30_000, // 30s in ms
                minOnDuration: 60_000, // 60s in ms
                zone: {clazz: true, coolers: false, thermostats: false},
            },
        });
        const contactSensor = makeDevice({
            id: 'window',
            zone: 'root',
            capabilities: {alarm_contact: new DeviceCapability(true, NOW - 10_000)},
        });
        const heater = makeDevice({
            id: 'heater',
            zone: 'root',
            deviceClass: DeviceClass.heater,
            capabilities: {onoff: new DeviceCapability(true, NOW - 20_000)},
        });
        const calc = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, contactSensor, heater]));

        // Contact opened 10s ago (20s remaining on 30s delay), heater turned on 20s ago (40s remaining on 60s minOnDuration)
        const res1 = calc.calculateHeaterSwitching(vthermo, root);
        expect(res1.getNextCalculationDelay()).toBe(20_000);
        // Heater is kept on due to minOnDuration
        expect(res1.getRequests().find(r => r.id === 'heater')).toBeUndefined();

        // Advance time by 45s so both contact delay and minOnDuration have expired, while temp is in hysteresis band (19.8°C)
        vi.setSystemTime(NOW + 45_000);
        contactSensor.setLocalCapabilityValue('alarm_contact', false);
        vthermo.setLocalCapabilityValue('measure_temperature', 19.8); // inside [19.5, 20.5] hysteresis band, vt_onoff is now false
        const res2 = calc.calculateHeaterSwitching(vthermo, root);
        expect(res2.getRequests()).toContainEqual(
            expect.objectContaining({id: 'heater', capabilityId: 'onoff', value: false}),
        );
        vi.useRealTimers();
    });

    it('raises target_temperature on physical thermostats/ACs when cooling turns off and supports 0°C readings', () => {
        const root = makeZone('root');
        const vthermo = makeVThermo({
            capabilities: {
                measure_temperature: 21.0,
                target_temperature: 22.0,
                thermostat_mode: 'cool',
                vt_cooling: true,
            },
            deviceSettings: {
                hysteresis: 0.5,
                zone: {clazz: false, coolers: true, thermostats: true},
            },
        });
        const acThermostat = makeDevice({
            id: 'ac-thermo',
            zone: 'root',
            deviceClass: DeviceClass.airconditioner,
            capabilities: {
                measure_temperature: 21.2,
                target_temperature: 19.0,
            },
        });
        const zeroCThermostat = makeDevice({
            id: 'zero-thermo',
            zone: 'root',
            deviceClass: DeviceClass.thermostat,
            capabilities: {
                measure_temperature: 0,
                target_temperature: -2,
            },
        });

        const calc = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([vthermo, acThermostat, zeroCThermostat]),
        );
        const coolOffReqs = calc.calculateHeaterSwitching(vthermo, root).getRequests();
        // Cooling turns off at 21.0°C (target 22.0°C): AC target is raised to ceil(21.2 + 2) = 24°C
        expect(coolOffReqs).toContainEqual(
            expect.objectContaining({id: 'ac-thermo', capabilityId: 'target_temperature', value: 24}),
        );
        // Zero-degree thermostat in cool mode also raises target to ceil(0 + 2) = 2°C
        expect(coolOffReqs).toContainEqual(
            expect.objectContaining({id: 'zero-thermo', capabilityId: 'target_temperature', value: 2}),
        );
    });

    it('respects virtualClass for sensors, heaters, coolers, and thermostats without cross-matching sockets', () => {
        const root = makeZone('root');
        const heaterSocket = makeDevice({
            id: 'heater-socket',
            zone: 'root',
            deviceClass: DeviceClass.socket,
            virtualClass: DeviceClass.heater,
            capabilities: {onoff: false, measure_temperature: 19},
        });
        const fanSocket = makeDevice({
            id: 'fan-socket',
            zone: 'root',
            deviceClass: DeviceClass.socket,
            virtualClass: DeviceClass.fan,
            capabilities: {onoff: false},
        });
        const virtualThermostat = makeDevice({
            id: 'virtual-thermo',
            zone: 'root',
            deviceClass: DeviceClass.socket,
            virtualClass: DeviceClass.thermostat,
            capabilities: {measure_temperature: 20, target_temperature: 21},
        });

        const calc = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([heaterSocket, fanSocket, virtualThermostat]),
        );

        expect(
            calc
                .getHeaters(root, new Zones(), {zone: {clazz: true, sockets_heaters: false, thermostats: false}})
                .map(d => d.id),
        ).toEqual(['heater-socket']);
        // Even when sockets_coolers is enabled (and heaters disabled), heaterSocket (virtualClass: 'heater') must NEVER be matched as a cooler
        expect(
            calc
                .getCoolers(root, new Zones(), {
                    zone: {
                        clazz: false,
                        coolers: true,
                        sockets_heaters: false,
                        sockets_coolers: true,
                        thermostats: false,
                    },
                })
                .map(d => d.id),
        ).toEqual(['fan-socket']);
        expect(
            calc
                .getThermostats(root, new Zones(), {zone: {clazz: false, sockets_heaters: false, thermostats: true}})
                .map(d => d.id),
        ).toEqual(['virtual-thermo']);
        expect(
            calc
                .getTemperaturesInZone(root, {
                    sensor: false,
                    thermostat: true,
                    vthermo: false,
                    other: false,
                })
                .map(c => c.value),
        ).toEqual([20]);
    });

    it('turns off a cooler socket (virtualClass fridge) in a cooler-only zone when temperature (11°C) is below setpoint (13.5°C)', () => {
        const root = makeZone('vinskap');
        const vthermo = makeVThermo({
            id: 'vinskap-vthermo',
            zone: 'vinskap',
            capabilities: {
                onoff: true,
                thermostat_mode: 'auto',
                measure_temperature: 11.0,
                target_temperature: 13.5,
                [CAPABILITY_ACTIVE]: false,
                vt_cooling: false,
            },
            deviceSettings: {
                hysteresis: 0.5,
                onoffEnabled: false,
                zone: {
                    clazz: false,
                    coolers: false,
                    sockets_heaters: false,
                    sockets_coolers: true,
                    thermostats: false,
                },
                sub_zones: {
                    clazz: false,
                    coolers: false,
                    sockets_heaters: false,
                    sockets_coolers: false,
                    thermostats: false,
                },
            },
        });
        const coolerPlug = makeDevice({
            id: 'vinskap-kjoling',
            zone: 'vinskap',
            deviceClass: DeviceClass.socket,
            virtualClass: DeviceClass.fridge,
            capabilities: {onoff: true},
        });

        const calc = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([vthermo, coolerPlug]));
        const requests = calc.calculateHeaterSwitching(vthermo, root).getRequests();

        expect(requests).toContainEqual(
            expect.objectContaining({id: 'vinskap-kjoling', capabilityId: 'onoff', value: false}),
        );
        expect(vthermo.getLocalCapabilityValue(CAPABILITY_ACTIVE)?.value).toBe(false);
    });

    it('matches all Homey SDK v3 cooling and heating virtualClasses (fridge, freezer, fridge_and_freezer, airconditioning, radiator, fireplace, boiler, waterheater, heatpump)', () => {
        const root = makeZone('root');
        const coolerDevices = ['fridge', 'freezer', 'fridge_and_freezer', 'airconditioning', 'airtreatment'].map(vc =>
            makeDevice({
                id: `cool-${vc}`,
                zone: 'root',
                deviceClass: DeviceClass.socket,
                virtualClass: vc,
                capabilities: {onoff: true},
            }),
        );
        const heaterDevices = ['radiator', 'fireplace', 'boiler', 'waterheater', 'heatpump'].map(vc =>
            makeDevice({
                id: `heat-${vc}`,
                zone: 'root',
                deviceClass: DeviceClass.socket,
                virtualClass: vc,
                capabilities: {onoff: false},
            }),
        );

        const calc = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([...coolerDevices, ...heaterDevices]));

        // Matched via 'coolers: true' OR 'sockets_coolers: true'
        expect(calc.getCoolers(root, new Zones(), {zone: {coolers: true}}).map(d => d.id)).toEqual(
            coolerDevices.map(d => d.id),
        );
        expect(calc.getCoolers(root, new Zones(), {zone: {clazz: true, sockets_coolers: true}}).map(d => d.id)).toEqual(
            coolerDevices.map(d => d.id),
        );

        // Matched via 'clazz: true' (heaters) OR 'sockets_heaters: true'
        expect(calc.getHeaters(root, new Zones(), {zone: {clazz: true}}).map(d => d.id)).toEqual(
            heaterDevices.map(d => d.id),
        );
        expect(
            calc.getHeaters(root, new Zones(), {zone: {coolers: true, sockets_heaters: true}}).map(d => d.id),
        ).toEqual(heaterDevices.map(d => d.id));
    });
});

describe('VThermoDeviceCalculator target propagation', () => {
    it('applies offset and clamps virtual thermostat targets', () => {
        const calculator = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([]));
        const recipient = makeVThermo({targetSettings: {offset: 2, min: 10, max: 25}});
        expect(calculator.calculateTargetTemperature(recipient, 20)).toBe(22);
        expect(calculator.calculateTargetTemperature(recipient, 5)).toBe(10);
        expect(calculator.calculateTargetTemperature(recipient, 30)).toBe(25);
        expect(calculator.calculateTargetTemperature(makeDevice(), 20)).toBe(20);
    });

    it('honors a zero minimum target temperature', () => {
        const recipient = makeVThermo({targetSettings: {min: 0, max: 25}});
        expect(
            new VThermoDeviceCalculator(new Zones(), makeDevicesStub([])).calculateTargetTemperature(recipient, -5),
        ).toBe(0);
    });

    it('honors zero and negative maximum target temperatures', () => {
        const calculator = new VThermoDeviceCalculator(new Zones(), makeDevicesStub([]));
        expect(calculator.calculateTargetTemperature(makeVThermo({targetSettings: {max: 0}}), 5)).toBe(0);
        expect(calculator.calculateTargetTemperature(makeVThermo({targetSettings: {min: -10, max: -1}}), 5)).toBe(-1);
        expect(calculator.calculateTargetTemperature(makeVThermo({targetSettings: {min: -10, max: -1}}), -20)).toBe(
            -10,
        );
    });

    it('does not clamp target temperatures when limits are undefined', () => {
        const recipient = makeVThermo({targetSettings: {min: undefined, max: undefined}});
        expect(
            new VThermoDeviceCalculator(new Zones(), makeDevicesStub([])).calculateTargetTemperature(recipient, -5),
        ).toBe(-5);
    });

    it('updates enabled virtual thermostats in direct children and physical thermostats in deeper descendants', () => {
        const grandchild = makeZone('grandchild', 'child');
        const child = makeZone('child', 'root', [grandchild]);
        const root = makeZone('root', undefined, [child]);
        const source = makeVThermo({
            id: 'source',
            zone: 'root',
            capabilities: {target_temperature: 22},
            targetSettings: {
                sub_zones: {to_vthermo: true},
                all_sub_zones: {to_other: true},
            },
        });
        const childVirtual = makeVThermo({
            id: 'child-virtual',
            dataId: 'child-data',
            zone: 'child',
            capabilities: {target_temperature: 20},
            targetSettings: {offset: 1, target_update_enabled: true},
        });
        const deepPhysical = makeDevice({
            id: 'deep-physical',
            driverId: 'physical-driver',
            deviceClass: DeviceClass.thermostat,
            zone: 'grandchild',
            capabilities: {target_temperature: 19},
        });
        const calculator = new VThermoDeviceCalculator(
            new Zones(),
            makeDevicesStub([source, childVirtual, deepPhysical]),
        );
        expect(calculator.calculateTargetTemperatures(source, root).getRequests()).toEqual([
            expect.objectContaining({id: 'child-virtual', value: 23}),
            expect.objectContaining({id: 'deep-physical', value: 22}),
        ]);
    });

    it('does not update virtual recipients that disabled target updates', () => {
        const child = makeZone('child', 'root');
        const root = makeZone('root', undefined, [child]);
        const source = makeVThermo({
            id: 'source',
            targetSettings: {sub_zones: {to_vthermo: true}},
            capabilities: {target_temperature: 22},
        });
        const recipient = makeVThermo({
            id: 'recipient',
            zone: 'child',
            targetSettings: {target_update_enabled: false},
            capabilities: {target_temperature: 20},
        });
        expect(
            new VThermoDeviceCalculator(new Zones(), makeDevicesStub([source, recipient]))
                .calculateTargetTemperatures(source, root)
                .getRequests(),
        ).toEqual([]);
    });
});
