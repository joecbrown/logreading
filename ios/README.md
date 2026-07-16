# iPad App — Setup in Xcode

This folder contains Swift source files, not a complete Xcode project —
Xcode project files aren't practical to hand-write outside Xcode itself.
Here's how to turn this into a real, buildable project.

## 1. Create the Xcode project

1. Open Xcode → **File → New → Project**
2. Choose **iOS → App**, click Next
3. Product Name: `ReadingTime` (matches `ReadingTimeApp.swift`'s struct
   name, though this isn't strictly required)
4. Interface: **SwiftUI**. Language: **Swift**
5. Uncheck "Use Core Data" and "Include Tests" (fine to add tests later)
6. Save it wherever you like — a sensible spot is right inside this repo,
   e.g. `reading-app/ios/ReadingTimeXcode/`

## 2. Replace the generated files with these

Xcode will have generated its own `ReadingTimeApp.swift`, `ContentView.swift`,
etc. Delete those (Xcode sidebar → right-click → Delete → Move to Trash),
then drag the files from this folder into the Xcode project navigator:

- `Models.swift`
- `ChildStore.swift`
- `APIClient.swift`
- `AudioSessionManager.swift`
- `ReadingSessionViewModel.swift`
- `ReadingTimeApp.swift`
- `Views/ContentView.swift`
- `Views/AddChildView.swift`
- `Views/ReadingSessionView.swift`
- `Views/SettingsView.swift`

When Xcode asks, choose "Copy items if needed" and make sure your app
target's checkbox is checked.

## 3. Add microphone permission (required — the app will crash without this)

1. Click your project in the navigator → select the **ReadingTime** target
2. Go to the **Info** tab
3. Add a row: key **Privacy - Microphone Usage Description**, value
   something like "Used to detect when your child is reading aloud, so
   the timer can pause automatically during breaks."

## 4. Set the deployment target

Project settings → General tab → set **Minimum Deployments** to **iOS 17**
(needed for the `#Preview` macro and a couple of modern SwiftUI APIs used
here).

## 5. Signing (per your earlier question about the dev account)

Project settings → **Signing & Capabilities** → choose your Apple ID under
Team (a free personal account works for installing on your own device —
see the note from earlier in this project about the 7-day re-signing
limit).

## 6. Build and run on a real device

Simulator microphone input is unreliable for this kind of audio-level
work — test on an actual iPad connected via USB (or wirelessly, once
paired once via USB). Select your iPad as the run destination in Xcode's
toolbar, then press the Run button (▶).

## 7. Before it's actually useful

- **Settings → API Base URL** needs the API Gateway invoke URL, which
  doesn't exist until the REST API is deployed (see the main README's
  "Deploying the REST API" section) — until then, sessions won't log
  anywhere, though the local recording/auto-pause logic can still be
  tested on its own.
- **Tune `silenceThresholdDB`** in `AudioSessionManager.swift` — the
  default (-35 dBFS) is a guess. Test in the room this will actually be
  used in, and watch whether the "Paused" badge in the app triggers
  correctly during real silence vs. real reading.
