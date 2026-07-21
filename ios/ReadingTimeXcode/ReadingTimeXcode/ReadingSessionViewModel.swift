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
    @Published var questions: [ComprehensionQuestion]?
    @Published var isCheckingForQuestions = false

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
        questions = nil
        do {
            try await audio.start()
            isRecording = true
        } catch {
            errorMessage = "Couldn't start recording: \(error.localizedDescription)"
        }
    }

    /// Stops the session, uploads the recorded audio for transcription
    /// (if there's anything to upload), logs the session, and refreshes
    /// the balance.
    ///
    /// The upload step is deliberately best-effort: if requesting an
    /// upload URL or the actual upload fails (network hiccup, backend not
    /// deployed yet, etc.), the session is still logged with just
    /// minutesRead — bonus-hour tracking shouldn't be held hostage by the
    /// transcription pipeline. You just won't get WPM/questions for that
    /// particular session.
    func stopSession() async {
        let recordingURL = audio.stop()
        isRecording = false

        let minutes = audio.activeMinutes
        guard minutes > 0 else {
            errorMessage = "No active reading time was recorded."
            return
        }

        var sessionId: String? = nil
        if let recordingURL {
            do {
                let uploadInfo = try await APIClient.shared.requestUploadUrl(childId: child.id, grade: child.grade)
                try await APIClient.shared.uploadAudio(fileURL: recordingURL, to: uploadInfo.uploadUrl)
                sessionId = uploadInfo.sessionId
            } catch {
                // Best-effort, as noted above — log but don't surface as
                // a blocking error; the session log below still happens.
                print("Audio upload failed (session will still be logged without it): \(error)")
            }
        }

        do {
            let result = try await APIClient.shared.logSession(
                childId: child.id,
                minutesRead: minutes,
                sessionId: sessionId
            )
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

    /// Checks whether comprehension questions are ready yet for the most
    /// recent session. Transcription + question generation happens
    /// asynchronously in the backend and can take anywhere from under a
    /// minute to several minutes — this is meant to be called from a
    /// manual "Check for questions" button rather than polled
    /// automatically, to avoid hammering the API.
    func checkForQuestions() async {
        guard let sessionId = lastResult?.sessionId else {
            errorMessage = "No session to check questions for yet."
            return
        }
        isCheckingForQuestions = true
        defer { isCheckingForQuestions = false }
        do {
            if let response = try await APIClient.shared.getQuestions(childId: child.id, sessionId: sessionId) {
                questions = response.questions
            } else {
                errorMessage = "Questions aren't ready yet — try again in a bit."
            }
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
