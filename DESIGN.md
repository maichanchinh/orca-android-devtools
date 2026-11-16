# DESIGN.md — Android Run DevTools

> UI/UX implementation specification · v1.0 · 2026-11-16
> Target: VS Code / Cursor extension webview sidebar; adaptable to wider editor panel.

## 1. Design direction

Redesign the current Android Run panel as a **compact, developer-first control surface** for detecting Android Gradle projects, selecting devices/variants, building, installing, launching, and inspecting logs.

Design priorities, in order:
1. **One-click Run** for a recognized project, usable device, and default configuration.
2. **Truthful system state**: project recognition, device connectivity, build/install/launch progress are separate signals.
3. **Small surface area**: progressive disclosure for advanced tools and profiles; avoid duplicated labels and unused space.
4. **Agent-friendly**: UI actions mirror explicit commands with observable output and errors.
5. **Accessible and theme-native**: respect VS Code theme tokens and keyboard navigation.

## 2. Current UX issues

The existing screenshot shows a large empty header, duplicate `Not recognized` / `Not ready` statuses, broad vertical spacing, device selector still visible but disabled-looking, an oversized disabled Run button, and an unhelpfully truncated error (`No Gradle Android project ...`). The user lacks a clear recovery action or explanation of how a project is recognized.

## 3. Information architecture

### Compact sidebar (recommended default)

```text
┌────────────────────────────────────────┐
│ ANDROID RUN             ↻  ⚙  ⋯       │
│ ● Ready · closetalk.app                │
│ ~/dev/closetalk.app         [Open]     │
├────────────────────────────────────────┤
│ Device                                 │
│ [📱 SM G990E · Online           ▾] [↻] │
│                                        │
│ Variant              Profile           │
│ [ Debug | Release ]  [Default      ▾]  │
│                                        │
│ Options                                │
│ ☑ Install APK      ☑ Launch app       │
│ ☐ Clear app data   [More options ▾]    │
│                                        │
│ [ ▶ Run                           ▾ ]  │
├────────────────────────────────────────┤
│ ● Ready           [Logs] [Terminal]    │
└────────────────────────────────────────┘
```

- At <= 340 CSS px, stack Variant and Profile vertically; keep one primary action and avoid horizontal overflow.
- At >= 520 CSS px, use a two-column options row and optionally show `Run | Build | Devices | Logs` tabs. In the narrow sidebar **do not use five top-level tabs**: they steal space from the primary run flow.
- Hide tabs or present secondary commands in `⋯` / command palette when space is limited.

### Structure

| Region | Contents | Rules |
| --- | --- | --- |
| Header | `ANDROID RUN`, refresh, settings, overflow | Small and sticky only if scrolling |
| Project context | Project name + recognition state + root path | Clicking name/path opens project details; never claim ready from device connection alone |
| Device | Detected devices (model, serial, transport, state), refresh | Always visible even without a project |
| Build configuration | Debug/Release, optional Profile | Detect variants from Gradle; fallback Debug/Release only if valid |
| Options | Install APK, Launch app, Clear app data, advanced | Install and launch are distinct; don't imply launch without installation succeeds |
| Primary action | Run + split menu | Disabled only when requirements fail; show why |
| Footer | Current phase, last error, Logs/Terminal | Long errors wrap in expanded details, not truncated without access |

## 4. Visual system

**Theme-first implementation**: use VS Code CSS variables rather than hardcoded colors where available.

| Token | Preferred | Dark mockup fallback |
| --- | --- | --- |
| Canvas | `var(--vscode-sideBar-background)` | `#0F1117` |
| Surface | `var(--vscode-editorWidget-background)` | `#161A22` |
| Text | `var(--vscode-foreground)` | `#E6E9F0` |
| Muted | `var(--vscode-descriptionForeground)` | `#A0A7B5` |
| Border | `var(--vscode-panel-border)` | `#343B49` |
| Primary | `var(--vscode-button-background)` | `#7855DC` |
| Primary text | `var(--vscode-button-foreground)` | `#FFFFFF` |
| Focus ring | `var(--vscode-focusBorder)` | `#9C80F8` |
| Success | `var(--vscode-testing-iconPassed)` | `#22C55E` |
| Warning | `var(--vscode-editorWarning-foreground)` | `#F59E0B` |
| Error | `var(--vscode-editorError-foreground)` | `#EF4444` |

- Spacing scale: 4 / 8 / 12 / 16 / 24 px. Body font inherits IDE font, generally 12–13 px; section labels 11–12 px; project name 13–14 px.
- Control height: 30–34 px; primary Run 36–40 px; radius 6–8 px. Avoid a giant CTA in a narrow sidebar.
- Icons: consistent 16 px outline set or VS Code Codicons. Do not use emoji as production icons.
- Minimum contrast: WCAG AA for text; ensure clear visible keyboard focus, not color-only status.
- Respect high contrast, reduced motion, and theme changes.

## 5. Functional requirements and interactions

### 5.1 Project recognition

- Observe workspace folders and active editor changes; rescan when requested.
- Recognize Android Gradle projects through `settings.gradle(.kts)`, modules with Android application plugin, and optional `gradlew`; **`gradlew` alone is not sufficient**.
- Support multiple workspace roots and multiple application modules with explicit selector when ambiguous.
- Show state `Scanning…`, `Recognized`, `Not recognized`, or `Recognition error`.
- For unrecognized workspace: show `No Android application module detected`, with **Select project folder**, **Rescan**, and expandable **Detection details**.
- Do not auto-execute untrusted Gradle scripts while merely detecting a project; obtain workspace trust/consent before build commands.

### 5.2 Device selection

- Populate from `adb devices -l`; parse `device`, `offline`, `unauthorized`, and emulator states. Keep serial stable as device ID.
- Show friendly model and shortened serial; full serial in tooltip/details.
- Refresh devices without losing a still-valid selection; if a selection disappears, surface `Device disconnected` and require reselection.
- Device-specific help: `Authorize USB debugging`, `Reconnect device`, `Start emulator` (only if supported).
- When possible offer `Open Android settings`, `View device logs`; advanced wireless debugging is optional.
- Never run against an offline/unauthorized device.

### 5.3 Variant and profile

- Detect available app build variants and application IDs; `Debug/Release` is only a shortcut for existing variants.
- Provide a Profile selector only when configured or when useful; default configuration works without creating a file.
- Project-local `.android-devtools.json` is optional, human-readable, and limited to overrides. Missing keys inherit discovered defaults.
- Do not assume `applicationId` can reliably be extracted from regex in `build.gradle.kts`; prefer Gradle model/APK metadata or a build-generated manifest/package resolution.

### 5.4 Primary Run

Default pipeline:

`Validate project/device → Gradle assemble selected variant → Locate APK output → Install APK (if enabled) → Launch main activity (if enabled) → Report result`.

- Build command uses wrapper when available, e.g. `./gradlew :app:assembleDebug`; Windows uses `gradlew.bat`.
- Honor module selection and exact variant/task name. For multi-APK outputs, select the correct artifact for device ABI/density or use a supported split-install approach; do not silently pick the first `*.apk`.
- APK installation: `adb -s <serial> install -r <apk>` for a single compatible APK; use appropriate multi-package/split installation for split APKs.
- Launch through resolved launchable activity/package, e.g. `adb -s <serial> shell am start -n <package>/<activity>`; do not assume package equals app module name.
- Clear Data (if checked) uses `adb -s <serial> shell pm clear <resolvedApplicationId>` **before launching** and only after package resolution; explain that this deletes local app storage.
- `Install APK` off means build-only unless Launch is available for an already-installed app; validate and explain this combination.
- Split menu commands: `Run`, `Build only`, `Install existing APK`, `Launch installed app`, `Clean`, and `Build AAB` (Release/application module only where supported).
- During execution: replace Run with `Stop` where cancellation is supported; show stage, duration, incremental output, and final exit status.
- Guard against concurrent conflicting operations on the same project/device; allow independent work where safe.

### 5.5 Logs and error recovery

- Footer displays latest stage and concise outcome. `Show logs` opens detailed panel / output channel.
- Separate **Build output** from **Logcat**. Clearing visible logs must not delete files, project state, or build artifacts.
- Errors must include failed command/stage, exit code (when known), actionable message, and expandable stderr.
- Copy command, copy error, retry failed stage when safe. Redact secrets from logs and shared bug reports.
- Avoid always polling logcat in the background; start/stop it explicitly or only when log view is active.

## 6. State model

Project, device, and operation state are orthogonal; the top-level badge is a **derived summary**, not the single source of truth.

| Context | User-facing state | Run enabled? | Next action |
| --- | --- | --- | --- |
| No workspace | `Open an Android project` | No | Open/select folder |
| Scanning | `Detecting Android project…` | No | Rescan after timeout |
| Not recognized | `No Android application module found` | No | Select project / Detection details |
| Project ready, no device | `Connect a device or start an emulator` | No for Run; Yes for Build | Refresh devices |
| Unauthorized device | `Authorize USB debugging` | No for Run | Authorization help |
| Ready | `Ready · <module> · <variant>` | Yes | Run |
| Building | `Building <variant>…` | No (Stop when supported) | View build logs |
| Installing | `Installing on <device>…` | No | View output |
| Launching | `Launching app…` | No | View output |
| Success | `App launched` or `Build completed` | Yes | Run again / Logs |
| Failed | `Build failed` / `Install failed` / `Launch failed` | Retry when safe | View error details |
| Cancelled | `Operation cancelled` | Yes if ready | Run |

## 7. Suggested configuration (optional)

File: `.android-devtools.json` at workspace root. Only store non-default preferences and explicit profiles. This is a proposed schema, not a claim about existing extension support.

```json
{
  "$schema": "./schemas/android-devtools.schema.json",
  "project": {
    "module": ":app"
  },
  "run": {
    "variant": "debug",
    "install": true,
    "launch": true,
    "clearData": false
  },
  "profiles": {
    "staging": {
      "variant": "stagingDebug"
    }
  }
}
```

- Don't persist detected device serial as a mandatory project default; it can change.
- Avoid saving secrets, signing credentials, or local absolute paths in repository config.
- Generated or discoverable defaults should stay outside this file.
- Add JSON schema validation and migration if config format evolves.

## 8. Layout and interaction acceptance criteria

- [ ] Recognized project + online device can Run using defaults without opening Settings.
- [ ] No project case shows useful recovery actions, not an unexplained disabled UI.
- [ ] ADB device list remains usable even if project detection fails.
- [ ] Sidebar at 280 px has no clipped primary controls or horizontal scroll.
- [ ] Status differentiates project recognition, device readiness, build, install, launch, and failure.
- [ ] Controls display disabled reason with hover/focus detail.
- [ ] No silent Gradle invocation during discovery in an untrusted workspace.
- [ ] Debug and Release variants map to actual available Gradle tasks.
- [ ] Clear Data warns appropriately and targets the resolved application ID.
- [ ] Build output and Logcat are separate and accessible.
- [ ] Commands quote and validate paths/device IDs correctly across platforms.
- [ ] Keyboard navigation, screen readers, dark/light/high-contrast themes work.

## 9. Implementation notes for AI coding agents

1. Audit current UI components, extension host message protocol, discovery logic, and command execution **before modifying files**.
2. Implement a typed UI state representation: `ProjectState`, `DeviceState`, `BuildConfig`, `OperationState`.
3. Keep commands in the extension host/backend; **webview must not directly shell out**.
4. Prefer the IDE's native components/theme tokens and existing icon system; avoid heavyweight UI dependencies.
5. Make phases observable through events; don't infer success from the process starting.
6. Provide small integration tests around detection, device parsing, variant resolution, and command construction.
7. Provide visual tests/screenshot review for minimum-width sidebar, empty state, ready state, running state, and failed state.

## 10. Implementation order

**P0:** Clear header/project empty state; device selector; variant; primary action; accurate status/errors.

**P1:** Split Run options; profiles; module detection; cancellation; build/log separation.

**P2:** Advanced actions, emulator management, wireless debugging, deeper diagnostics, optional persisted configuration.

---

Reference: User-provided screenshot (existing Android Run UI). The redesigned concept image is illustrative; this specification takes precedence where presentation and behavior differ.
