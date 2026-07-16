// AudioSessionManager.swift
//
// Monitors the microphone locally to detect speech vs. silence, so the
// reading timer can auto-pause after a stretch of silence and resume when
// reading starts again. This is the capability Alexa fundamentally can't
// provide (see PROJECT_SUMMARY.md) — it's only possible because this is a
// native app with continuous mic access.
//
// IMPORTANT CAVEATS (read before relying on this):
// 1. This detects *volume*, not speech — it's a simple RMS/decibel
//    threshold, not real voice-activity detection or speech recognition.
//    It cannot distinguish a kid reading aloud from, say, a TV in the
//    next room. `silenceThresholdDB` below WILL need tuning against your
//    actual room and device — treat the current value as a starting guess.
// 2. This has not been run/tested (no Xcode/device access in the
//    environment that wrote it). The concurrency design below (background
//    audio thread doing the RMS math + file write, hopping to the main
//    thread only for @Published state changes) is the standard pattern
//    for this kind of code, but it deserves real on-device verification —
//    in particular watch for the purple runtime warning "Publishing
//    changes from background threads", which would mean something is
//    still being touched off-main-thread.
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

    /// How long silence must persist before auto-pausing (the 45-second
    /// rule from the plan).
    var silenceThresholdSeconds: TimeInterval = 45

    /// Volume threshold (dBFS) above which audio counts as "speech".
    /// Typical quiet room: -55 to -45 dBFS. Normal speaking voice a foot or
    /// two from the mic: usually -25 to -10 dBFS. Start here, then tune
    /// after testing in the room this will actually be used in.
    var silenceThresholdDB: Float = -35

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

    private var activeTimer: Timer?

    /// Starts monitoring + recording. Throws if mic permission wasn't
    /// granted or the audio session couldn't be configured. Must be called
    /// from the main thread (SwiftUI action handlers already are).
    func start() throws {
        guard state == .idle else { return }
        try configureSession()
        try startEngine()
        lastSpeechTime = Date()
        isCurrentlyReading = true
        state = .reading
        activeSeconds = 0
        startActiveTimer()
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
        let url = docsDir.appendingPathComponent("session-\(Int(Date().timeIntervalSince1970)).caf")
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

        if isSpeech || isCurrentlyReading {
            try? audioFile?.write(from: buffer)
        }

        if isSpeech {
            lastSpeechTime = now
            if !isCurrentlyReading {
                isCurrentlyReading = true
                DispatchQueue.main.async { [weak self] in self?.state = .reading }
            }
        } else if isCurrentlyReading, now.timeIntervalSince(lastSpeechTime) >= silenceThresholdSeconds {
            isCurrentlyReading = false
            DispatchQueue.main.async { [weak self] in self?.state = .paused }
        }
    }

    private func startActiveTimer() {
        // start() runs on the main thread (SwiftUI action handlers already
        // are), so Timer.scheduledTimer attaches to the main run loop and
        // this closure fires on the main thread — no dispatch needed.
        activeTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, self.state == .reading else { return }
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
