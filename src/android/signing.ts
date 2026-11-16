const signingProperty = /^-Pandroid\.injected\.signing\.(?:store|key)\.password=/

export function defaultDebugSigningArgs(keystorePath: string): string[] {
  return [
    `-Pandroid.injected.signing.store.file=${keystorePath}`,
    '-Pandroid.injected.signing.store.password=android',
    '-Pandroid.injected.signing.key.alias=AndroidDebugKey',
    '-Pandroid.injected.signing.key.password=android'
  ]
}

export function redactSigningArgs(args: string[]): string[] {
  return args.map((arg) => signingProperty.test(arg) && !arg.startsWith('-Pandroid.injected.signing.store.file=')
    ? `${arg.slice(0, arg.indexOf('=') + 1)}<redacted>`
    : arg)
}

export function redactSigningText(text: string): string {
  return text.replace(/(-Pandroid\.injected\.signing\.(?:store|key)\.password=)[^\s"']+/g, '$1<redacted>')
}
