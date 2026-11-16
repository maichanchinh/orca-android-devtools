import { assert, test } from 'orca/testing'
import { buildRemoteShellCommand, encodeIntentExtra } from './intent.ts'

test('intent extras map Android scalar types to their am start flags', () => {
  const extras = [
    { key: 'text', type: 'string', value: 'hello world!' },
    { key: 'enabled', type: 'boolean', value: true },
    { key: 'ratio', type: 'float', value: 3.14159 },
    { key: 'year', type: 'int', value: 2015 },
    { key: 'counter', type: 'long', value: '9223372036854775807' }
  ] as const
  assert.deepEqual(extras.map((extra) => encodeIntentExtra(extra)), [
    ['--es', 'text', 'hello world!'], ['--ez', 'enabled', 'true'], ['--ef', 'ratio', '3.14159'],
    ['--ei', 'year', '2015'], ['--el', 'counter', '9223372036854775807']
  ])
})

test('remote shell command preserves spaces, apostrophes and max signed long as individual arguments', () => {
  const command = buildRemoteShellCommand(['am', 'start', '--es', 'text', 'hello world!', '--es', 'quote', "it's fine", '--el', 'counter', '9223372036854775807'])
  assert.equal(command, "am start --es text 'hello world!' --es quote 'it'\\''s fine' --el counter 9223372036854775807")
})
