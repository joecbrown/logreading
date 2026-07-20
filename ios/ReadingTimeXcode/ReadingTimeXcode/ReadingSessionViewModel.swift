// ReadingSessionViewModel.swift
//
// Ties AudioSessionManager (local mic monitoring/auto-pause) to APIClient
// (backend logging), for one child's reading session.

import Foundation
import Combine

@MainActor
final class ReadingSessionViewModel: ObservableObject {
    let child: Child
    let audio = AudioSessionManager()

    @Published var isRecording = false
    @Published var lastResult: SessionLogResponse?
    @Published var balance: BalanceResponse?
    @Published var errorMessage: String?

    private var cancellables = Set<AnyCancellable>()

    init(child: Child) {
        self.child = child
        // `audio` is its own ObservableObject — nested ObservableObjects
        // don't automatically propagate change notifications upward in
        // SwiftUI, so without this, the live timer/status display in
        // ReadingSessionView would silently stop updating even though
        // audio.state and audio.activeSeconds are changing correctly.
        audio.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    func startSession() async {
        errorMessage = nil
        do {
            try await audio.start()
            isRecording = true
        } catch {
            errorMessage = "Couldn't start recording: \(error.localizedDescription)"
        }
    }

    /// Stops the session, sends the active-minutes total to the backend,
    /// and refreshes the balance. The recorded audio file's URL is
    /// returned by audio.stop() but not yet used anywhere — that's the
    /// next piece of work (S3 + Amazon Transcribe pipeline).
    func stopSession() async {
        let recordingURL = audio.stop()
        isRecording = false
        _ = recordingURL // TODO: upload for transcription once that pipeline exists

        let minutes = audio.activeMinutes
        guard minutes > 0 else {
            errorMessage = "No active reading time was recorded."
            return
        }

        do {
            let result = try await APIClient.shared.logSession(childId: child.id, minutesRead: minutes)
            lastResult = result
            await refreshBalance()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    func refreshBalance() async {
        do {
            balance = try await APIClient.shared.getBalance(childId: child.id)
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
