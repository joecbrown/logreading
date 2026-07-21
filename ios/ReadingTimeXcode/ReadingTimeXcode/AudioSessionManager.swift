// AudioSessionManager.swift
//
// Monitors the microphone locally to detect speech vs. silence, so the
// reading timer can auto-pause after a stretch of silence and resume when
// reading starts again. This is the capability Alexa fundamentally can't
// provide (see PROJECT_SUMMARY.md) — it's only possible because this is a
// native app with continuous mic access.
//
// STATUS: confirmed working via real testing (Simulator, using the Mac's
// mic, with actual kids reading) — not just written and hoped-for. Real
// bugs were found and fixed through that testing, not just code review;
// see PROJECT_SUMMARY.md for the full story. Known caveats:
//
// 1. This detects *volume*, not speech — it's a simple RMS/decibel
//    threshold, not real voice-activity detection or speech recognition.
//    It cannot distinguish a kid reading aloud from other loud sounds.
//    Mitigated (not eliminated) by requiring sustained loudness before
//    counting it as speech — see `minimumSustainedSpeechSeconds` below,
//    which specifically filters out sharp transients like keyboard clicks
//    (found via real testing: typing near the mic was briefly triggering
//    false "reading resumed" states before this fix).
// 2. `silenceThresholdDB` was originally a guess (-35) that turned out to
//    be *louder* than actual reading volume in practice — meaning it
//    never triggered at all. Fixed by adding a live on-screen debug
//    readout (`currentDecibels`) to measure real values, which is how the
//    current -48 figure was derived. That debug readout is still in the
//    UI (ReadingSessionView) — worth keeping for now in case further
//    rooms/devices need retuning, safe to remove once this feels solid
//    long-term.
// 3. `silenceThresholdSeconds` (how long silence must persist before
//    auto-pausing) went through two rounds of real-world tuning: 45s →
//    20s → 10s, each round based on it feeling too slow in actual use.
// 4. Requires an actual "Privacy - Microphone Usage Description" entry in
//    the Xcode target's Info tab — without it, iOS force-kills the app
//    the moment it touches the microphone (a `TCC_CRASHING_DUE_TO_
//    PRIVACY_VIOLATION` crash, not a code bug). This was missed once
//    already after a project/file mixup — worth double-checking it's
//    still there if this ever gets crash reports on a fresh install.
// 5. Depending on this project's Swift concurrency settings, comparing
//    `ReadingState` values (e.g. `state == .reading`) from a plain,
//    non-actor-isolated closure (like Timer's) can trigger a compiler
//    error about the enum's Equatable conformance being main-actor
//    isolated — even in a closure that happens to run on the main thread
//    in practice. Where that came up (the active-time timer), the fix was
//    checking `isCurrentlyReading` (a plain Bool) instead of the enum.
// 6. Only tested in Xcode's Simulator so far (using the Mac's own mic) —
//    not yet on a physical iPad. A real device may behave differently.
//
// Recording only happens while actively reading — silent/paused stretches
// are skipped, so the exported audio file has no dead air (keeps file size
// down and simplifies later transcription).

import AVFoundation
import Combine

enum ReadingState {
    case idle
    case reading
    case paused
}

/// Deliberately NOT @MainActor — the audio engine's tap callback fires on
/// an internal audio thread, and this class needs to do real work there
/// (RMS calculation, file writes) without hopping to the main thread first.
/// Only the @Published properties are updated via explicit main-thread
/// dispatch, since SwiftUI requires that.
final class AudioSessionManager: ObservableObject {
    @Published private(set) var state: ReadingState = .idle
    @Published private(set) var activeSeconds: Int = 0
    @Published var lastError: String?

    /// Live volume reading in dBFS, exposed purely for on-screen debugging
    /// while tuning `silenceThresholdDB` — lets you actually watch the
    /// number react to speech/silence in real time, instead of guessing
    /// why auto-pause is or isn't triggering.
    @Published private(set) var currentDecibels: Float = -160

    /// How long silence must persist before auto-pausing. Started at the
    /// plan's original 45s, tuned to 20s after first real-kid testing felt
    /// too slow to react, then tuned again to 10s after 20s still felt too
    /// slow.
    var silenceThresholdSeconds: TimeInterval = 10

    /// Volume threshold (dBFS) above which audio counts as "speech".
    /// Measured via the on-screen debug readout (see currentDecibels):
    /// this room's quiet baseline came in around -56 dB, and actual
    /// reading aloud measured -38 to -41 dB. -48 sits with real margin on
    /// both sides — well above the quiet floor, well below even the
    /// softest reading moments — rather than the original -35 guess,
    /// which turned out to be louder than the actual reading volume,
    /// meaning it was never triggering at all.
    var silenceThresholdDB: Float = -48

    private let engine = AVAudioEngine()
    private var audioFile: AVAudioFile?
    private var recordingURL: URL?

    // These two are only ever touched from inside handleBuffer(), which
    // AVAudioEngine calls serially from one internal audio thread — so
    // there's no cross-thread race on them specifically. The ordering in
    // stop() (remove tap + stop engine before nil-ing audioFile) matters:
    // it ensures no further callback can fire after cleanup begins.
    private var lastSpeechTime = Date()
    private var isCurrentlyReading = false

    // Tracks how long the volume has been continuously above threshold.
    // A single loud buffer (a keyboard click, a cough, a door) shouldn't
    // count as "reading resumed" — only sustained loudness should. Real
    // speech naturally holds volume across a whole word/sentence; sharp
    // transients don't.
    private var loudStreakStart: Date?
    private let minimumSustainedSpeechSeconds: TimeInterval = 0.3

    private var activeTimer: Timer?

    /// Starts monitoring + recording. Throws if mic permission wasn't
    /// granted or the audio session couldn't be configured. Must be called
    /// from the main thread (SwiftUI action handlers already are).
    func start() async throws {
        guard state == .idle else { return }
        try await ensureMicrophonePermission()
        try configureSession()
        try startEngine()
        lastSpeechTime = Date()
        loudStreakStart = nil
        isCurrentlyReading = true
        state = .reading
        activeSeconds = 0
        startActiveTimer()
    }

    /// The likely cause of an early SIGABRT crash on `engine.inputNode`:
    /// touching the audio engine without permission ever having been
    /// granted (or even asked). Configuring an AVAudioSession category
    /// alone does not reliably trigger the system permission prompt —
    /// this requests it explicitly and waits for a real answer first.
    private func ensureMicrophonePermission() async throws {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return
        case .denied:
            throw NSError(
                domain: "AudioSessionManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Microphone access was denied. Enable it in Settings > Privacy & Security > Microphone."]
            )
        case .undetermined:
            let granted = await AVAudioApplication.requestRecordPermission()
            if !granted {
                throw NSError(
                    domain: "AudioSessionManager",
                    code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Microphone access was not granted."]
                )
            }
        @unknown default:
            return
        }
    }

    /// Stops monitoring/recording. Returns the local file URL of the
    /// recorded audio (reading segments only), or nil if nothing was
    /// recorded. Uploading this file is the next piece of work (S3 +
    /// Amazon Transcribe pipeline) — not wired up yet.
    func stop() -> URL? {
        stopActiveTimer()
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning {
            engine.stop()
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        isCurrentlyReading = false
        state = .idle
        let url = recordingURL
        recordingURL = nil
        audioFile = nil
        return url
    }

    /// Minutes of actual active reading time (excludes paused/silent time).
    /// This is what gets sent to POST /children/{childId}/sessions — the
    /// backend trusts it as-is, since it has no way to see local pauses.
    var activeMinutes: Double {
        Double(activeSeconds) / 60.0
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)

        let docsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = docsDir.appendingPathComponent("session-\(Int(Date().timeIntervalSince1970)).wav")
        audioFile = try AVAudioFile(forWriting: url, settings: format.settings)
        recordingURL = url

        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.handleBuffer(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    /// Runs on the audio engine's internal thread — NOT the main thread.
    /// Keep this fast, and never touch @Published properties directly;
    /// state transitions are dispatched to the main thread below.
    private func handleBuffer(_ buffer: AVAudioPCMBuffer) {
        let db = Self.decibels(of: buffer)
        let isSpeech = db > silenceThresholdDB
        let now = Date()

        DispatchQueue.main.async { [weak self] in self?.currentDecibels = db }

        if isSpeech || isCurrentlyReading {
            try? audioFile?.write(from: buffer)
        }

        if isSpeech {
            if loudStreakStart == nil {
                loudStreakStart = now
            }
            let sustainedLongEnough = now.timeIntervalSince(loudStreakStart!) >= minimumSustainedSpeechSeconds
            if sustainedLongEnough {
                lastSpeechTime = now
                if !isCurrentlyReading {
                    isCurrentlyReading = true
                    DispatchQueue.main.async { [weak self] in self?.state = .reading }
                }
            }
        } else {
            loudStreakStart = nil
            if isCurrentlyReading, now.timeIntervalSince(lastSpeechTime) >= silenceThresholdSeconds {
                isCurrentlyReading = false
                DispatchQueue.main.async { [weak self] in self?.state = .paused }
            }
        }
    }

    private func startActiveTimer() {
        // start() runs on the main thread (SwiftUI action handlers already
        // are), so Timer.scheduledTimer attaches to the main run loop and
        // this closure fires on the main thread — no dispatch needed.
        //
        // Deliberately checks `isCurrentlyReading` (a plain Bool) here
        // rather than `state == .reading` (the enum): depending on this
        // project's actor-isolation settings, ReadingState's Equatable
        // conformance can end up implicitly tied to the main actor, which
        // conflicts with this closure being a plain, non-isolated context
        // as far as the compiler is concerned — even though it happens to
        // run on the main thread in practice. Bool sidesteps that entirely.
        activeTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, self.isCurrentlyReading else { return }
            self.activeSeconds += 1
        }
    }

    private func stopActiveTimer() {
        activeTimer?.invalidate()
        activeTimer = nil
    }

    private static func decibels(of buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return -160 }
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return -160 }

        var sumOfSquares: Float = 0
        for channel in 0..<channelCount {
            let samples = channelData[channel]
            for i in 0..<frameLength {
                sumOfSquares += samples[i] * samples[i]
            }
        }
        let meanSquare = sumOfSquares / Float(frameLength * channelCount)
        let rms = sqrt(meanSquare)
        return 20 * log10(max(rms, 1e-7))
    }
}
