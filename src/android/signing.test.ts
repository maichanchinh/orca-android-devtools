import { assert, test } from 'orca/testing'
import { defaultDebugSigningArgs, redactSigningArgs, redactSigningText } from './signing.ts'

test('Release uses the default Android debug key without exposing signing passwords in logs', () => {
  const signingArgs = defaultDebugSigningArgs('/Users/test/.android/debug.keystore')
  assert.deepEqual(signingArgs, [
    '-Pandroid.injected.signing.store.file=/Users/test/.android/debug.keystore',
    '-Pandroid.injected.signing.store.password=android',
    '-Pandroid.injected.signing.key.alias=AndroidDebugKey',
    '-Pandroid.injected.signing.key.password=android'
  ])
  assert.deepEqual(redactSigningArgs(signingArgs), [
    '-Pandroid.injected.signing.store.file=/Users/test/.android/debug.keystore',
    '-Pandroid.injected.signing.store.password=<redacted>',
    '-Pandroid.injected.signing.key.alias=AndroidDebugKey',
    '-Pandroid.injected.signing.key.password=<redacted>'
  ])
  assert.equal(redactSigningText('Gradle saw -Pandroid.injected.signing.store.password=android'), 'Gradle saw -Pandroid.injected.signing.store.password=<redacted>')
})
