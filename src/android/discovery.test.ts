import { assert, test } from 'orca/testing'
import { collectGradleVariants, parseAdbDevices } from './discovery.ts'

test('variant discovery keeps assembleRelease even when Gradle has no installRelease task', () => {
  const tasks = [
    'assembleDebug - Assembles main output for variant debug',
    'assembleRelease - Assembles main output for variant release',
    'assembleAndroidTest - Assembles all test applications.',
    'installDebug - Installs the Debug build.',
    'uninstallRelease - Uninstalls the Release build.'
  ].join('\n')
  assert.deepEqual(collectGradleVariants(tasks), ['Debug', 'Release'])
})

test('ADB device parser preserves online, offline, unauthorized and emulator device states', () => {
  const devices = parseAdbDevices([
    'List of devices attached',
    'ABC123 device product:g991 model:SM_G991B transport_id:2',
    'DEF456 offline transport_id:3',
    'GHI789 unauthorized usb:1-2',
    'emulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64',
    'not-a-device',
    ''
  ].join('\n'))
  assert.deepEqual(devices, [
    { serial: 'ABC123', state: 'device', model: 'SM G991B' },
    { serial: 'DEF456', state: 'offline', model: 'DEF456' },
    { serial: 'GHI789', state: 'unauthorized', model: 'GHI789' },
    { serial: 'emulator-5554', state: 'device', model: 'sdk gphone64 x86 64' }
  ])
})
