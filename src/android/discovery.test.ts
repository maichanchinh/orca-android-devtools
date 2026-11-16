import { assert, test } from 'orca/testing'
import { collectGradleVariants } from './discovery.ts'

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
