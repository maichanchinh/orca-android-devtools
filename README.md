# Android Devtools

Compact Android run configuration panel for Orca. The panel, Orca command and standalone CLI share the resolver and runner in `src/android/`.

## Run in Orca

Open **Android Devtools** from the right sidebar. It follows the focused Orca workspace automatically; choose an online device and an available variant, configure install options, then press **Run**. The panel always builds before running. ADB devices remain visible without a recognized Android project; offline and unauthorized devices are identified but cannot be selected for a run. Debug and Release shortcuts are enabled only when that variant exists. Release builds use the machine's default Android debug keystore for local device testing; this key is not suitable for publishing. Project discovery metadata is cached per project/module until **Refresh**; device discovery is cached for 30 seconds. Use **Refresh** after connecting a device or changing project build files. YAML is reread on every discovery. Panel selections are remembered independently for each project and are not written to YAML unless a profile is saved. Profiles are saved to `.android-devtools.yaml` in the project root, and a missing file uses defaults; open **Profile manager** from the panel header to edit them.

The Command Palette command **Android Devtools: Run Selected Project** runs the focused project. For device selection or Intent extras, use the panel or pass options to the standalone CLI.

## Standalone CLI

Requires Node.js 22+ and the Android SDK tools. It has no npm dependencies:

```sh
node src/cli.ts discover --project /path/to/android-project
node src/cli.ts run --project /path/to/android-project --module :app --variant debug --device emulator-5554
node src/cli.ts run --profile premium-ads --extra debug_premium_ads:boolean=true
node src/cli.ts profile list --project /path/to/android-project
node src/cli.ts profile save --project /path/to/android-project --name premium-ads --module :app --variant Debug
node src/cli.ts profile delete --project /path/to/android-project --name premium-ads
```

Supported options include `--uri`, `--no-build`, `--no-install`, `--clear-data`, `--activity`, `--timeout` (milliseconds), and repeated `--extra key:type=value`. Extra types: `string`, `boolean`, `int`, `long`, `float`, `double`. Live build/run progress is written to stderr; the final result remains one JSON object on stdout. Failures include a stable error code and relevant output.

Set `ANDROID_DEVTOOLS_DEBUG=1` in the Orca process environment to include detailed discovery cache diagnostics in `orca plugin logs local.android-devtools`. High-level discovery, profile and run outcomes are always logged. The panel's log area starts hidden and separates build output from install/launch output. Each section can be copied or inserted into the sole agent terminal in the focused workspace; insertion does not submit the prompt. **Clear log** empties both sections.

## Configuration

Only non-default profile values need to be stored. Profiles and project overrides use this shape:

```yaml
version: 1
profile: premium-ads
profiles:
  premium-ads:
    uri: "blurface://premium?source=debug"
    extras:
      - key: debug_premium_ads
        type: boolean
        value: true
overrides:
  module: ":app"
```

Precedence is selected profile, project overrides, then current-run UI or CLI values. `uri` maps to Android Intent data (`-d`); extras map to typed Intent arguments such as `--ez debug_premium_ads true`. The separate **Profile manager** screen edits these values and saves them to YAML. SDK paths are not written. `android describe` discovers project metadata when supported; otherwise the Gradle wrapper discovers variants. Builds always use the Gradle wrapper. Android CLI installs APKs when supported, with ADB fallback. ADB handles exact package clearing and typed Intent launch because `android run` has no Intent-extra options.

## Development and validation

Orca loads `.ts` and `.tsx` directly; no bundling step or runtime dependency installation is needed. Generate host typings with `orca plugin types .`, then run:

```sh
tsc -p .
orca plugin validate . --json
orca plugin check . --json
```

The plugin uses Orca's trusted-worker profile with `workspace:read`, `agent:read`, `terminal:send` and `storage:own`. Storage keeps per-project discovery metadata across worker restarts until Refresh; it does not cache project YAML. Gradle and ADB execute with argument arrays, no shell. Runs are serialized by workspace and device, cancellable, and leave incremental build caches intact.
