// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed what the worker reads so check shows more than the first state.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {
    results: {
      'workspace.list': { workspaces: [{ id: 'demo', kind: 'folder', name: 'Demo Project', path: '/tmp', branch: null, hostId: null }], truncated: false },
      'workspace.readContext': { branch: '', displayName: 'Demo Project', terminals: [] }
    },
    requests: {
      'android.workspaces': { workspaces: [{ id: 'demo', kind: 'folder', name: 'Demo Project', path: '/tmp', hostId: 'local' }], focusedId: 'demo', focusedName: 'Demo Project' },
      'android.discover': { project: { root: '/tmp', module: ':app', modules: [':app'], variants: ['debug', 'release'], applicationId: 'com.example.demo', gradleWrapper: '/tmp/gradlew', androidCli: false, supported: true }, devices: [{ serial: 'emulator-5554', model: 'Pixel_8', state: 'device' }], config: { version: 1, profiles: {} } }
    }
  },
  counted: {
    storage: { total: 41 },
    results: {
      'workspace.list': { workspaces: [{ id: 'demo', kind: 'folder', name: 'Demo Project', path: '/tmp', branch: null, hostId: null }], truncated: false },
      'workspace.readContext': { branch: '', displayName: 'Demo Project', terminals: [] }
    },
    requests: {
      'android.workspaces': { workspaces: [{ id: 'demo', kind: 'folder', name: 'Demo Project', path: '/tmp', hostId: 'local' }], focusedId: 'demo', focusedName: 'Demo Project' },
      'android.discover': { project: { root: '/tmp', module: ':app', modules: [':app'], variants: ['debug', 'release'], applicationId: 'com.example.demo', gradleWrapper: '/tmp/gradlew', androidCli: false, supported: true }, devices: [{ serial: 'emulator-5554', model: 'Pixel_8', state: 'device' }], config: { version: 1, profiles: {} } }
    }
  }
})
