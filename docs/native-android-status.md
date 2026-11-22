# Native Android status

## Baseline and gap assessment

| Capability | Status | Evidence / boundary |
| --- | --- | --- |
| Android packaging | VOLLSTAENDIG IMPLEMENTIERT | Native `android/app` module with Kotlin and Compose build |
| Existing mobile patrol/panic UI | TEILWEISE IMPLEMENTIERT | Existing web `/mobile` remains; native dashboard now covers the same server contracts |
| Backend authentication | VOLLSTAENDIG IMPLEMENTIERT | Device UUID, cookie session and CSRF header use `/api/v1/auth/login` and `/api/v1/auth/logout` |
| Tenant and role scope | VOLLSTAENDIG IMPLEMENTIERT | User and tenant values come from the authenticated backend response; no local authority is created |
| Room offline outbox | VOLLSTAENDIG IMPLEMENTIERT | `mobile_outbox` stores ordered patrol/panic mutations and conflict state |
| WorkManager synchronization | VOLLSTAENDIG IMPLEMENTIERT | Connected periodic and one-shot workers retry in creation order |
| Idempotency | VOLLSTAENDIG IMPLEMENTIERT | Existing `client_event_id` payloads are replayed against the backend receipt contract |
| Android Keystore | VOLLSTAENDIG IMPLEMENTIERT | AES-GCM encrypts the session bundle; no password or server secret is stored |
| Real mobile dashboard | VOLLSTAENDIG IMPLEMENTIERT | Authenticated tenant/role/session and outbox state are visible in Compose |
| Native NFC | TEILWEISE IMPLEMENTIERT | ReaderMode reads the physical tag UID; server-side route validation remains authoritative |
| Camera | TEILWEISE IMPLEMENTIERT | Android camera intent and runtime permission are wired; media upload is not part of the current backend contract |
| FCM | TEILWEISE IMPLEMENTIERT | Firebase service receives and stores token locally; backend registration/delivery worker is not configured |
| Tablet / large screens | NICHT VERIFIZIERT | No physical tablet or emulator matrix was available in this environment |
| NFC hardware | NICHT VERIFIZIERT | No NFC-capable device/tag and no ADB hardware acceptance run available |
| Camera hardware | NICHT VERIFIZIERT | No camera-capable device/emulator acceptance run available |
| FCM delivery | NICHT VERIFIZIERT | No `google-services.json`, Firebase project, credentials or delivery worker is present |

## Security and privacy

The app sends only the existing authenticated device metadata and uses the
backend's tenant-scoped session and CSRF controls. Session material is encrypted
with a Keystore-backed AES-GCM key. No credentials, FCM credentials, API tokens,
or private keys are committed. Device IDs remain installation identifiers, not
hardware fingerprints.

## Validation and limitations

Run `./gradlew assembleDebug` and the available Android unit/instrumented checks
in an environment with the Android SDK, Gradle distribution and dependency
repositories available. Physical NFC, camera, background scheduling, tablet
layout and FCM delivery require a device/emulator matrix and are explicitly not
represented as passed solely by a successful compile.

## Priority next steps

1. Configure a production backend base URL and CI-safe Firebase project
   references, then register FCM tokens through a dedicated authenticated
   backend endpoint.
2. Execute NFC, camera, offline/online, revoked-device and WorkManager tests on
   API 24, current Android, NFC hardware and tablet profiles.
3. Add a backend media contract only if camera evidence is required operationally;
   otherwise keep camera capture as an extension point rather than creating a
   parallel data store.
