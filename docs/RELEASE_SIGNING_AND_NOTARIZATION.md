# Release Signing And Notarization

P9G signing configuration target: Developer ID Application with Hardened Runtime.

Current credential status: no valid code signing identities were found on this machine.

Observed command result:

`security find-identity -v -p codesigning` returned `0 valid identities found`.

## What P9G Configured

- Release `ENABLE_HARDENED_RUNTIME = YES`
- Release `ENABLE_APP_SANDBOX = NO`
- Release `CODE_SIGN_STYLE = Manual`
- Release `CODE_SIGN_IDENTITY = Developer ID Application`
- Release `OTHER_CODE_SIGN_FLAGS = --timestamp`
- Release entitlements path: `Resources/Release.entitlements`
- Release entitlement set: empty

## Evidence Boundaries

Compile success means the app builds.

Signed build success means the app bundle and nested code were signed with a valid Developer ID Application identity.

Gatekeeper assessment means `spctl --assess --type execute` accepted the signed artifact.

Notarization means Apple notary service accepted the submitted artifact and the ticket was stapled.

Human acceptance means a person signed off the visible external system behavior.

Runtime handoff means DeskPet submitted a request to the system handler.

System accepted means macOS accepted an open request. It does not prove visible UI or external action completion.

External action completed is out of scope for phone, directions navigation, booking, purchase, payment, form submission, and merchant contact.

## Status

Release compilation may be verified with unsigned code signing disabled as compilation evidence only. It must not be reported as production signed.

Production signed build, nested code verification, Gatekeeper assessment, and notarization are blocked until a valid Developer ID Application certificate and secure notarization credentials are available.

Expected status when code/config/tests pass but credentials remain unavailable:

`P9G_RELEASE_CONFIGURATION_READY_SIGNING_CREDENTIALS_UNAVAILABLE`

## Notarization Procedure Template

Use an existing secure keychain profile. Do not put Apple ID passwords or app-specific passwords into source, scripts, logs, or shell history.

Template:

```sh
xcrun notarytool submit <artifact.zip> --keychain-profile <profile> --wait
xcrun stapler staple <DeskPet.app>
spctl --assess --type execute --verbose=4 <DeskPet.app>
```

Do not report notarized unless submission accepted, staple succeeded, and Gatekeeper assessment passed.
